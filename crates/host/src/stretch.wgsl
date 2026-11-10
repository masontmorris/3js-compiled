@group(0) @binding(0) var image: texture_2d<f32>;
@group(0) @binding(1) var linear: sampler;

struct Vertex {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
}

@vertex
fn vertex(@builtin(vertex_index) index: u32) -> Vertex {
    let uv = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
    return Vertex(vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0), uv);
}

@fragment
fn fragment(input: Vertex) -> @location(0) vec4f {
    return textureSample(image, linear, input.uv);
}
