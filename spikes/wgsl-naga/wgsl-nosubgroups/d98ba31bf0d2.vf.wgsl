
struct VarysStruct {
	@builtin( position ) Position: vec4f,
	@location( 0 ) vTex : vec2f,
	@location( 1 ) @interpolate(flat, either) vBaseArrayLayer: u32,
};

@group( 0 ) @binding ( 2 )
var<uniform> flipY: u32;

@vertex
fn mainVS(
		@builtin( vertex_index ) vertexIndex : u32,
		@builtin( instance_index ) instanceIndex : u32 ) -> VarysStruct {

	var Varys : VarysStruct;

	var pos = array(
		vec2f( -1, -1 ),
		vec2f( -1,  3 ),
		vec2f(  3, -1 ),
	);

	let p = pos[ vertexIndex ];
	let mult = select( vec2f( 0.5, -0.5 ), vec2f( 0.5, 0.5 ), flipY != 0 );
	Varys.vTex = p * mult + vec2f( 0.5 );
	Varys.Position = vec4f( p, 0, 1 );
	Varys.vBaseArrayLayer = instanceIndex;

	return Varys;

}

@group( 0 ) @binding( 0 )
var imgSampler : sampler;

@group( 0 ) @binding( 1 )
var img2d : texture_2d<f32>;

@fragment
fn main_2d( Varys: VarysStruct ) -> @location( 0 ) vec4<f32> {

	return textureSample( img2d, imgSampler, Varys.vTex );

}

@group( 0 ) @binding( 1 )
var img2dArray : texture_2d_array<f32>;

@fragment
fn main_2d_array( Varys: VarysStruct ) -> @location( 0 ) vec4<f32> {

	return textureSample( img2dArray, imgSampler, Varys.vTex, Varys.vBaseArrayLayer );

}

const faceMat = array(
  mat3x3f(  0,  0,  -2,  0, -2,   0,  1,  1,   1 ),   // pos-x
  mat3x3f(  0,  0,   2,  0, -2,   0, -1,  1,  -1 ),   // neg-x
  mat3x3f(  2,  0,   0,  0,  0,   2, -1,  1,  -1 ),   // pos-y
  mat3x3f(  2,  0,   0,  0,  0,  -2, -1, -1,   1 ),   // neg-y
  mat3x3f(  2,  0,   0,  0, -2,   0, -1,  1,   1 ),   // pos-z
  mat3x3f( -2,  0,   0,  0, -2,   0,  1,  1,  -1 ),   // neg-z
);

@group( 0 ) @binding( 1 )
var imgCube : texture_cube<f32>;

@fragment
fn main_cube( Varys: VarysStruct ) -> @location( 0 ) vec4<f32> {

	return textureSample( imgCube, imgSampler, faceMat[ Varys.vBaseArrayLayer ] * vec3f( fract( Varys.vTex ), 1 ) );

}
