// Loads the built folio-2025 (../folio-2025/dist) in headless Edge with WebGPU,
// drives the intro and the car for a while, and dumps every WGSL module passed
// to GPUDevice.createShaderModule into ./wgsl plus ./manifest.json (same layout
// as spikes/wgsl-naga, so ./validate.mjs can run on it).
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = dirname( fileURLToPath( import.meta.url ) );
const dist = join( here, '..', 'folio-2025', 'dist' );
const wgslDir = join( here, 'wgsl' );
const channel = process.env.BROWSER_CHANNEL ?? 'msedge';
const driveSeconds = Number( process.env.DRIVE_SECONDS ?? 60 );

rmSync( wgslDir, { recursive: true, force: true } );
mkdirSync( wgslDir, { recursive: true } );

const mime = {
	'.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
	'.wasm': 'application/wasm', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp',
	'.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary', '.ktx': 'application/octet-stream',
	'.ktx2': 'image/ktx2', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4',
	'.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.eot': 'application/vnd.ms-fontobject',
};

const server = createServer( ( req, res ) => {
	if ( req.url.startsWith( '/__probe' ) ) { res.writeHead( 200, { 'content-type': 'text/html' } ); res.end( '<!doctype html><title>probe</title>' ); return; }
	const path = normalize( decodeURIComponent( new URL( req.url, 'http://x' ).pathname ) ).replace( /^([\\/])+/, '' );
	let file = join( dist, path || 'index.html' );
	if ( ! file.startsWith( dist ) || ! existsSync( file ) ) { res.writeHead( 404 ); res.end(); return; }
	try {
		const body = readFileSync( file );
		res.writeHead( 200, { 'content-type': mime[ extname( file ).toLowerCase() ] ?? 'application/octet-stream' } );
		res.end( body );
	} catch { res.writeHead( 404 ); res.end(); }
} );
await new Promise( r => server.listen( 0, '127.0.0.1', r ) );
const url = `http://127.0.0.1:${ server.address().port }/#skip`;

const shaders = new Map(); // hash -> { stage, label, firstSeen }
const errors = [];
const log = [];
const t0 = Date.now();

const browser = await chromium.launch( {
	channel,
	headless: true,
	args: [ '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=d3d11', '--autoplay-policy=no-user-gesture-required' ],
} );
const page = await browser.newPage( { viewport: { width: 1280, height: 720 } } );

await page.exposeFunction( '__wgslDump', ( code, label ) => {
	const hash = createHash( 'sha1' ).update( code ).digest( 'hex' ).slice( 0, 12 );
	if ( shaders.has( hash ) ) return;
	const stage = /@compute/.test( code ) ? 'compute' : /@fragment/.test( code ) ? 'fragment' : /@vertex/.test( code ) ? 'vertex' : 'unknown';
	shaders.set( hash, { stage, label: label ?? null, firstSeen: ( Date.now() - t0 ) / 1000 } );
	writeFileSync( join( wgslDir, `${ hash }.${ stage }.wgsl` ), code );
} );
await page.exposeFunction( '__gpuError', ( msg ) => errors.push( msg ) );

await page.addInitScript( () => {
	const wrap = () => {
		if ( typeof GPUDevice === 'undefined' || GPUDevice.prototype.__wrapped ) return;
		GPUDevice.prototype.__wrapped = true;
		const original = GPUDevice.prototype.createShaderModule;
		GPUDevice.prototype.createShaderModule = function ( descriptor ) {
			window.__wgslDump( descriptor.code, descriptor.label );
			const module = original.call( this, descriptor );
			module.getCompilationInfo?.().then( info => {
				for ( const m of info.messages ) if ( m.type === 'error' ) window.__gpuError( `compile ${ descriptor.label ?? '' }: ${ m.message }` );
			} );
			return module;
		};
		const originalRequestDevice = GPUAdapter.prototype.requestDevice;
		GPUAdapter.prototype.requestDevice = async function ( ...args ) {
			const device = await originalRequestDevice.apply( this, args );
			device.addEventListener( 'uncapturederror', e => window.__gpuError( `uncaptured: ${ e.error.message }` ) );
			window.__adapterInfo = { info: this.info ? { vendor: this.info.vendor, architecture: this.info.architecture, device: this.info.device, description: this.info.description } : null, features: [ ...device.features ] };
			return device;
		};
	};
	wrap();
} );

page.on( 'console', m => { if ( m.type() === 'error' || m.type() === 'warning' ) log.push( `[${ m.type() }] ${ m.text() }`.slice( 0, 300 ) ); } );
page.on( 'pageerror', e => log.push( `[pageerror] ${ e.message }`.slice( 0, 300 ) ) );

const hasGPU = await ( async () => {
	await page.goto( `http://127.0.0.1:${ server.address().port }/__probe` );
	return page.evaluate( async () => {
		if ( ! navigator.gpu ) return { ok: false, why: 'no navigator.gpu' };
		const a = await navigator.gpu.requestAdapter( { powerPreference: 'high-performance' } );
		if ( ! a ) return { ok: false, why: 'no adapter' };
		return { ok: true, info: { vendor: a.info?.vendor, architecture: a.info?.architecture, description: a.info?.description }, features: [ ...a.features ] };
	} );
} )();
console.log( 'adapter probe:', JSON.stringify( hasGPU ) );
if ( ! hasGPU.ok ) { await browser.close(); server.close(); process.exit( 2 ); }

await page.goto( url );
const sleep = ms => new Promise( r => setTimeout( r, ms ) );
const step = async ( label, fn ) => { try { await fn(); } catch ( e ) { log.push( `[step ${ label }] ${ e.message }` ); } console.log( `t=${ ( ( Date.now() - t0 ) / 1000 ).toFixed( 0 ) }s ${ label }: ${ shaders.size } shaders` ); };

await step( 'loaded', () => sleep( 25000 ) );
await step( 'introStart', async () => { await page.keyboard.press( 'Enter' ); await sleep( 8000 ); } );
await step( 'drive', async () => {
	const end = Date.now() + driveSeconds * 1000;
	const pattern = [ [ 'ArrowUp', 3000 ], [ 'ArrowLeft', 800 ], [ 'ArrowUp', 2500 ], [ 'ArrowRight', 1200 ], [ 'ShiftLeft', 1500 ] ];
	let i = 0;
	await page.keyboard.down( 'ArrowUp' );
	while ( Date.now() < end ) {
		const [ key, ms ] = pattern[ i ++ % pattern.length ];
		await page.keyboard.down( key ); await sleep( ms ); if ( key !== 'ArrowUp' ) await page.keyboard.up( key );
	}
	await page.keyboard.up( 'ArrowUp' );
} );
await step( 'respawns via map', async () => {
	// Open map modal and click each location to visit other areas.
	await page.keyboard.press( 'KeyM' ); await sleep( 1500 );
	const count = await page.locator( '.js-map-container .location' ).count();
	for ( let k = 0; k < count; k ++ ) {
		await page.keyboard.press( 'KeyM' ).catch( () => {} ); await sleep( 800 );
		const loc = page.locator( '.js-map-container .location' ).nth( k );
		if ( await loc.isVisible().catch( () => false ) ) { await loc.click( { timeout: 2000 } ).catch( () => {} ); }
		await sleep( 4000 );
		await page.keyboard.down( 'ArrowUp' ); await sleep( 2500 ); await page.keyboard.up( 'ArrowUp' );
	}
} );
await step( 'quality toggle', async () => {
	await page.evaluate( () => document.querySelector( '.js-quality-toggle' )?.click() );
	await sleep( 5000 );
	await page.evaluate( () => document.querySelector( '.js-quality-toggle' )?.click() );
	await sleep( 5000 );
} );

const adapterInfo = await page.evaluate( () => window.__adapterInfo ?? null ).catch( () => null );
const backend = await page.evaluate( () => {
	const r = window.game?.rendering?.renderer; return r ? { webgpu: !! r.backend.isWebGPUBackend } : null;
} ).catch( () => null );
await browser.close();
server.close();

const manifest = { generatedAt: new Date().toISOString(), channel, adapterInfo, backend, errors, log: log.slice( 0, 200 ), shaders: {} };
for ( const [ hash, s ] of shaders ) manifest.shaders[ hash ] = { scenes: [ 'folio-2025' ], ...s };
writeFileSync( join( here, 'manifest.json' ), JSON.stringify( manifest, null, 2 ) );
const byStage = {}; for ( const s of shaders.values() ) byStage[ s.stage ] = ( byStage[ s.stage ] ?? 0 ) + 1;
console.log( 'unique shaders:', shaders.size, byStage, 'gpu errors:', errors.length, 'console errors/warnings:', log.length );
