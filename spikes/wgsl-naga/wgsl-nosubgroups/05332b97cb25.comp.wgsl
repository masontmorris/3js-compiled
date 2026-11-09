// Three.js r187 - Node System

// directives


// system
var<private> instanceIndex : u32;

// locals


// structs


// uniforms

struct nodeUniform0Struct {
	value : array< vec3<f32> >
};
@binding( 0 ) @group( 1 )
var<storage, read_write> nodeUniform0 : nodeUniform0Struct;

struct nodeUniform1Struct {
	value : array< vec3<f32> >
};
@binding( 1 ) @group( 1 )
var<storage, read_write> nodeUniform1 : nodeUniform1Struct;

struct renderStruct {
	nodeUniform2 : f32
};
@binding( 0 ) @group( 0 )
var<uniform> render : renderStruct;

struct objectStruct {
	nodeUniform3 : u32
};
@binding( 2 ) @group( 1 )
var<uniform> object : objectStruct;

// vars


// codes
fn tsl_mod_float( x : f32, y : f32 ) -> f32 { return x - y * floor( x / y ); }


@compute @workgroup_size( 64, 1, 1 )
fn main( @builtin( global_invocation_id ) globalId : vec3<u32>,
	@builtin( workgroup_id ) workgroupId : vec3<u32>,
	@builtin( local_invocation_id ) localId : vec3<u32>,
	@builtin( num_workgroups ) numWorkgroups : vec3<u32> ) {

	// local vars
	

	// system
	instanceIndex = globalId.x
		+ globalId.y * ( 64 * numWorkgroups.x )
		+ globalId.z * ( 64 * numWorkgroups.x ) * ( 1 * numWorkgroups.y );

	// flow
	// code

	if ( instanceIndex >= object.nodeUniform3 ) { return; }

	nodeUniform0.value[ instanceIndex ] = ( nodeUniform0.value[ instanceIndex ] + ( nodeUniform1.value[ instanceIndex ] * vec3<f32>( sin( render.nodeUniform2 ) ) ) );
	nodeUniform0.value[ instanceIndex ].y = ( tsl_mod_float( nodeUniform0.value[ instanceIndex ].y, 2.0 ) - 1.0 );

	

}
