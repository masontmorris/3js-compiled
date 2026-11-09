// Validates every dumped WGSL shader with naga, translates it to HLSL (SM 5.1 and 6.0)
// and SPIR-V, and compiles the HLSL with FXC / DXC from the Windows SDK.
// Writes report.json and prints a summary.
//
// Usage: node validate.mjs
// Env: NAGA (path to naga.exe), WINSDK_BIN (folder with dxc.exe / fxc.exe)

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const here = new URL( '.', import.meta.url ).pathname.replace( /^\/([A-Za-z]:)/, '$1' );
const NAGA = process.env.NAGA ?? join( homedir(), '.cargo', 'bin', 'naga.exe' );
const SDK = process.env.WINSDK_BIN ?? 'C:\\Program Files (x86)\\Windows Kits\\10\\bin\\10.0.26100.0\\x64';
const DXC = join( SDK, 'dxc.exe' );
const FXC = join( SDK, 'fxc.exe' );

const wgslDir = join( here, 'wgsl' );
const outDir = join( here, 'out' );
rmSync( outDir, { recursive: true, force: true } );
mkdirSync( outDir, { recursive: true } );

const manifest = JSON.parse( readFileSync( join( here, 'manifest.json' ), 'utf8' ) );

function run( exe, args ) {

	try {

		execFileSync( exe, args, { stdio: [ 'ignore', 'pipe', 'pipe' ], encoding: 'utf8' } );
		return { ok: true };

	} catch ( e ) {

		const text = `${ e.stdout ?? '' }${ e.stderr ?? '' }`.trim();
		return { ok: false, error: text.split( '\n' ).filter( l => l.trim() ).slice( 0, 6 ).join( '\n' ) };

	}

}

// Patches we consider "allowed" for wgpu: naga 30's WGSL frontend rejects the
// standard `enable subgroups;` directive, but accepts the subgroup builtins without it.
function patch( code ) {

	return code.replace( /^\s*enable\s+subgroups\s*;\s*$/gm, '// enable subgroups; (stripped for naga)' );

}

function entryPoints( code ) {

	const eps = [];
	const re = /@(vertex|fragment|compute)[^{]*?fn\s+([A-Za-z_][A-Za-z0-9_]*)/g;
	let m;
	while ( ( m = re.exec( code ) ) ) eps.push( { stage: m[ 1 ], name: m[ 2 ] } );
	return eps;

}

const profile = { vertex: 'vs', fragment: 'ps', compute: 'cs' };
const report = {};
const tally = { total: 0, validateRaw: 0, validatePatched: 0, spirv: 0, hlsl51: 0, hlsl60: 0, fxc: 0, dxc: 0 };

for ( const file of readdirSync( wgslDir ).filter( f => f.endsWith( '.wgsl' ) ).sort() ) {

	const hash = file.split( '.' )[ 0 ];
	const raw = readFileSync( join( wgslDir, file ), 'utf8' );
	const patched = patch( raw );
	const needsPatch = patched !== raw;
	const src = join( outDir, `${ hash }.wgsl` );
	writeFileSync( src, patched );

	const r = { file, scenes: manifest.shaders[ hash ]?.scenes ?? [], patched: needsPatch };
	tally.total ++;

	r.validateRaw = needsPatch ? run( NAGA, [ join( wgslDir, file ) ] ) : null;
	r.validate = run( NAGA, [ src ] );
	if ( r.validateRaw === null ) r.validateRaw = r.validate;
	if ( r.validateRaw.ok ) tally.validateRaw ++;
	if ( r.validate.ok ) tally.validatePatched ++;

	if ( r.validate.ok ) {

		r.spirv = run( NAGA, [ src, join( outDir, `${ hash }.spv` ) ] );
		if ( r.spirv.ok ) tally.spirv ++;

		const eps = entryPoints( patched );

		for ( const sm of [ '51', '60' ] ) {

			const hlsl = join( outDir, `${ hash }.sm${ sm }.hlsl` );
			const gen = run( NAGA, [ '--shader-model', sm, '--index-bounds-check-policy', 'ReadZeroSkipWrite', src, hlsl ] );
			r[ `hlsl${ sm }` ] = gen;
			if ( ! gen.ok ) continue;
			tally[ `hlsl${ sm }` ] ++;

			const compiler = sm === '51' ? 'fxc' : 'dxc';
			const results = eps.map( ( ep ) => {

				const target = `${ profile[ ep.stage ] }_${ sm === '51' ? '5_1' : '6_0' }`;
				const obj = join( outDir, `${ hash }.${ ep.name }.${ compiler }.bin` );
				const res = compiler === 'fxc'
					? run( FXC, [ '/nologo', '/T', target, '/E', ep.name, '/Fo', obj, hlsl ] )
					: run( DXC, [ '-nologo', '-T', target, '-E', ep.name, '-Fo', obj, hlsl ] );
				return { ep: ep.name, target, ...res };

			} );

			r[ compiler ] = { ok: results.length > 0 && results.every( x => x.ok ), results };
			if ( r[ compiler ].ok ) tally[ compiler ] ++;

		}

	}

	report[ hash ] = r;

}

writeFileSync( join( here, 'report.json' ), JSON.stringify( { tally, report }, null, 2 ) );

console.log( 'naga', execFileSync( NAGA, [ '--version' ], { encoding: 'utf8' } ).trim(), '| fxc', existsSync( FXC ), '| dxc', existsSync( DXC ) );
console.log( tally );

const failures = Object.values( report ).filter( r => ! r.validateRaw.ok || ! r.validate.ok || ! r.spirv?.ok || ! r.hlsl51?.ok || ! r.hlsl60?.ok || ! r.fxc?.ok || ! r.dxc?.ok );
for ( const f of failures ) {

	const stage = [ 'validateRaw', 'validate', 'spirv', 'hlsl51', 'hlsl60', 'fxc', 'dxc' ].find( k => ! f[ k ]?.ok );
	const err = f[ stage ]?.error ?? f[ stage ]?.results?.find( x => ! x.ok )?.error ?? '(not run)';
	console.log( `\n[${ stage }] ${ f.file } (${ f.scenes.join( ', ' ) })\n  ${ String( err ).split( '\n' ).slice( 0, 4 ).join( '\n  ' ) }` );

}
