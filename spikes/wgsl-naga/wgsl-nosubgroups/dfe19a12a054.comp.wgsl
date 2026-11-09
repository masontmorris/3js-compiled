// Three.js r187 - Node System

// directives


// system
var<private> instanceIndex : u32;

// locals


// structs


// uniforms
@binding( 1 ) @group( 0 ) var nodeUniform1 : texture_storage_2d<rgba8unorm, write>;

struct nodeUniform0Struct {
	value : array< atomic<u32> >
};
@binding( 0 ) @group( 0 )
var<storage, read_write> nodeUniform0 : nodeUniform0Struct;

struct objectStruct {
	nodeUniform2 : u32
};
@binding( 2 ) @group( 0 )
var<uniform> object : objectStruct;

// vars


// codes


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

	if ( instanceIndex >= object.nodeUniform2 ) { return; }

	atomicAdd( &nodeUniform0.value[ 0u ], 1u );
	let nodeConst0 = ( instanceIndex % 64u );
	let nodeConst1 = ( instanceIndex / 64u );
	textureStore( nodeUniform1, vec2<u32>( nodeConst0, nodeConst1 ), vec4<f32>( ( f32( nodeConst0 ) / 64.0 ), ( f32( nodeConst1 ) / 64.0 ), 0.0, 1.0 ) );

	

}
