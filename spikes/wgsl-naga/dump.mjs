// Runs three.js WebGPURenderer headlessly on Dawn (node `webgpu` package) and
// dumps every unique WGSL shader module it creates to ./wgsl, with a manifest
// mapping each shader to the scenes that produced it.
//
// Usage: node dump.mjs [sceneNameFilter]

import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { create, globals } from 'webgpu';

const ADAPTER = process.env.DAWN_ADAPTER ?? 'NVIDIA GeForce RTX 3060';

Object.assign( globalThis, globals );
const gpu = create( [ 'backend=d3d12', `adapter=${ ADAPTER }` ] );
Object.defineProperty( globalThis, 'navigator', {
	value: { gpu, userAgent: 'node', language: 'en-US' },
	configurable: true,
	writable: true
} );
globalThis.self ??= globalThis;
globalThis.requestAnimationFrame ??= ( cb ) => setTimeout( () => cb( performance.now() ), 16 );
globalThis.cancelAnimationFrame ??= ( id ) => clearTimeout( id );
// SMAANode builds its lookup textures from `new Image()`; a stub that never loads
// is enough for shader generation (the textures just stay unuploaded).
globalThis.Image ??= class StubImage {

	constructor() {

		this.width = 0;
		this.height = 0;
		this.complete = false;

	}

};

const OUT_NAME = process.env.DUMP_OUT ?? 'wgsl';
const OUT = new URL( `./${ OUT_NAME }/`, import.meta.url );
rmSync( OUT, { recursive: true, force: true } );
mkdirSync( OUT, { recursive: true } );

// --- shader capture ---------------------------------------------------------

let currentScene = 'init';
const shaders = new Map(); // hash -> record
const sceneResults = [];

function stageOf( code ) {

	const v = /@vertex/.test( code ), f = /@fragment/.test( code ), c = /@compute/.test( code );
	if ( c ) return 'comp';
	if ( v && f ) return 'vf';
	if ( v ) return 'vert';
	if ( f ) return 'frag';
	return 'unknown';

}

const origCreateShaderModule = GPUDevice.prototype.createShaderModule;
GPUDevice.prototype.createShaderModule = function ( descriptor ) {

	const code = descriptor.code;
	const hash = createHash( 'sha1' ).update( code ).digest( 'hex' ).slice( 0, 12 );
	let rec = shaders.get( hash );

	if ( rec === undefined ) {

		const stage = stageOf( code );
		rec = { file: `${ hash }.${ stage }.wgsl`, stage, scenes: [], tint: null, enables: [ ...code.matchAll( /^\s*enable\s+([^;]+);/gm ) ].map( m => m[ 1 ].trim() ) };
		shaders.set( hash, rec );
		writeFileSync( new URL( rec.file, OUT ), code );

	}

	if ( ! rec.scenes.includes( currentScene ) ) rec.scenes.push( currentScene );

	const module = origCreateShaderModule.call( this, descriptor );

	if ( rec.tint === null ) {

		rec.tint = 'pending';
		module.getCompilationInfo().then( ( info ) => {

			const errors = info.messages.filter( m => m.type === 'error' ).map( m => `${ m.lineNum }:${ m.linePos } ${ m.message }` );
			rec.tint = errors.length ? errors : 'ok';

		} ).catch( ( e ) => {

			rec.tint = [ `getCompilationInfo failed: ${ e }` ];

		} );

	}

	return module;

};

const deviceErrors = [];
const origRequestDevice = GPUAdapter.prototype.requestDevice;
GPUAdapter.prototype.requestDevice = async function ( ...args ) {

	const device = await origRequestDevice.apply( this, args );
	const onError = ( ev ) => deviceErrors.push( { scene: currentScene, message: String( ev.error?.message ?? ev.error ?? ev ) } );
	if ( typeof device.addEventListener === 'function' ) device.addEventListener( 'uncapturederror', onError );
	else device.onuncapturederror = onError;
	return device;

};

// --- headless canvas ---------------------------------------------------------

class StubCanvas {

	constructor( width = 256, height = 256 ) {

		this.width = width;
		this.height = height;
		this.style = {};
		this.clientWidth = width;
		this.clientHeight = height;
		this._context = makeContext( this );

	}

	getContext( type ) {

		return type === 'webgpu' ? this._context : null;

	}

	addEventListener() {}
	removeEventListener() {}
	setAttribute() {}
	getBoundingClientRect() {

		return { left: 0, top: 0, width: this.width, height: this.height, right: this.width, bottom: this.height };

	}

}

function makeContext( canvas ) {

	let config = null;
	let texture = null;

	return {
		canvas,
		configure( c ) {

			config = c;
			texture = null;

		},
		unconfigure() {

			config = null;
			texture = null;

		},
		getConfiguration() {

			return config;

		},
		getCurrentTexture() {

			if ( texture === null || texture.width !== canvas.width || texture.height !== canvas.height ) {

				texture?.destroy();
				texture = config.device.createTexture( {
					size: [ canvas.width, canvas.height ],
					format: config.format,
					usage: config.usage | GPUTextureUsage.TEXTURE_BINDING
				} );

			}

			return texture;

		}
	};

}

// --- scenes ------------------------------------------------------------------

const THREE = await import( 'three/webgpu' );
const TSL = await import( 'three/tsl' );
const { scenes } = await import( './scenes.mjs' );

const filter = process.argv[ 2 ];
let adapterLogged = false;

for ( const [ name, build ] of Object.entries( scenes ) ) {

	if ( filter && ! name.includes( filter ) ) continue;

	currentScene = name;
	const result = { name, ok: false, error: null, frames: 0 };
	sceneResults.push( result );

	let renderer;

	try {

		const canvas = new StubCanvas( 256, 256 );
		const params = { canvas, antialias: false, powerPreference: 'high-performance' };

		// DUMP_HIDE_FEATURES=subgroups,shader-f16 creates the device without those
		// features, to see what three emits when a native device doesn't expose them.
		if ( process.env.DUMP_HIDE_FEATURES ) {

			const hidden = process.env.DUMP_HIDE_FEATURES.split( ',' );
			const adapter = await navigator.gpu.requestAdapter( { powerPreference: 'high-performance' } );
			const requiredFeatures = [ ...adapter.features ].filter( f => ! hidden.includes( f ) );
			params.device = await adapter.requestDevice( { requiredFeatures } );

		}

		renderer = new THREE.WebGPURenderer( params );
		await renderer.init();

		if ( ! adapterLogged ) {

			const backend = renderer.backend;
			const info = backend.device.adapterInfo ?? {};
			console.log( `adapter: ${ info.vendor } ${ info.architecture } ${ info.device } (${ info.description }); compatibilityMode=${ backend.compatibilityMode }` );
			console.log( `device features: ${ [ ...backend.device.features ].sort().join( ', ' ) }` );
			adapterLogged = true;

		}

		const ctx = await build( { THREE, TSL, renderer } );
		const frames = ctx.frames ?? 2;

		for ( let i = 0; i < frames; i ++ ) {

			ctx.beforeFrame?.( i );
			if ( ctx.compute ) renderer.compute( ctx.compute );
			if ( ctx.pipeline ) ctx.pipeline.render();
			else if ( ctx.scene ) renderer.render( ctx.scene, ctx.camera );
			result.frames ++;

		}

		await renderer.backend.device.queue.onSubmittedWorkDone();
		result.ok = true;

	} catch ( e ) {

		result.error = String( e?.stack ?? e ).split( '\n' ).slice( 0, 4 ).join( ' | ' );

	} finally {

		try {

			renderer?.dispose();

		} catch {}

	}

	console.log( `${ result.ok ? 'ok  ' : 'FAIL' } ${ name }${ result.error ? '  -> ' + result.error : '' }` );

}

// let pending getCompilationInfo promises settle
await new Promise( r => setTimeout( r, 500 ) );

const manifest = {
	three: THREE.REVISION,
	adapter: ADAPTER,
	scenes: sceneResults,
	deviceErrors,
	shaders: Object.fromEntries( [ ...shaders.entries() ].map( ( [ h, r ] ) => [ h, r ] ) )
};

writeFileSync( new URL( OUT_NAME === 'wgsl' ? './manifest.json' : `./${ OUT_NAME }.manifest.json`, import.meta.url ), JSON.stringify( manifest, null, 2 ) );

const tintFails = [ ...shaders.values() ].filter( r => Array.isArray( r.tint ) );
console.log( `\nscenes: ${ sceneResults.filter( s => s.ok ).length }/${ sceneResults.length } ok; unique shaders: ${ shaders.size }; tint errors: ${ tintFails.length }; device errors: ${ deviceErrors.length }` );
for ( const e of deviceErrors.slice( 0, 20 ) ) console.log( `  device error [${ e.scene }]: ${ e.message.split( '\n' )[ 0 ] }` );

process.exit( 0 );
