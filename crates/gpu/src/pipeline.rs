use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Pipeline {
    pub label: String,
    pub layout: u32,
    pub vertex: Stage,
    pub fragment: Option<Stage>,
    pub buffers: Vec<VertexBuffer>,
    pub targets: Vec<Option<Target>>,
    pub primitive: Primitive,
    pub depth: Option<Depth>,
    pub samples: Samples,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Stage {
    pub module: u32,
    pub entry_point: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VertexBuffer {
    array_stride: u64,
    step_mode: wgpu::VertexStepMode,
    attributes: Vec<wgpu::VertexAttribute>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Target {
    format: wgpu::TextureFormat,
    blend: Option<wgpu::BlendState>,
    write_mask: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Primitive {
    topology: wgpu::PrimitiveTopology,
    strip_index_format: Option<wgpu::IndexFormat>,
    front_face: wgpu::FrontFace,
    cull_mode: Option<wgpu::Face>,
    unclipped_depth: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Depth {
    format: wgpu::TextureFormat,
    depth_write_enabled: Option<bool>,
    depth_compare: Option<wgpu::CompareFunction>,
    stencil_front: wgpu::StencilFaceState,
    stencil_back: wgpu::StencilFaceState,
    stencil_read_mask: u32,
    stencil_write_mask: u32,
    depth_bias: i32,
    depth_bias_slope_scale: f32,
    depth_bias_clamp: f32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Samples {
    count: u32,
    mask: u64,
    alpha_to_coverage_enabled: bool,
}

impl Pipeline {
    pub fn create(
        &self,
        device: &wgpu::Device,
        layout: Option<&wgpu::PipelineLayout>,
        vertex_module: &wgpu::ShaderModule,
        fragment_module: Option<&wgpu::ShaderModule>,
    ) -> Result<wgpu::RenderPipeline, String> {
        let buffers: Vec<_> = self
            .buffers
            .iter()
            .map(|buffer| {
                Some(wgpu::VertexBufferLayout {
                    array_stride: buffer.array_stride,
                    step_mode: buffer.step_mode,
                    attributes: &buffer.attributes,
                })
            })
            .collect();
        let targets: Vec<_> = self
            .targets
            .iter()
            .map(|target| {
                target
                    .as_ref()
                    .map(|target| {
                        Ok(wgpu::ColorTargetState {
                            format: target.format,
                            blend: target.blend,
                            write_mask: wgpu::ColorWrites::from_bits(target.write_mask)
                                .ok_or("invalid color write mask")?,
                        })
                    })
                    .transpose()
            })
            .collect::<Result<_, &str>>()?;
        let fragment = self
            .fragment
            .as_ref()
            .zip(fragment_module)
            .map(|(stage, module)| wgpu::FragmentState {
                module,
                entry_point: stage.entry_point.as_deref(),
                compilation_options: Default::default(),
                targets: &targets,
            });
        let primitive = wgpu::PrimitiveState {
            topology: self.primitive.topology,
            strip_index_format: self.primitive.strip_index_format,
            front_face: self.primitive.front_face,
            cull_mode: self.primitive.cull_mode,
            unclipped_depth: self.primitive.unclipped_depth,
            ..Default::default()
        };
        let depth_stencil = self.depth.as_ref().map(|depth| wgpu::DepthStencilState {
            format: depth.format,
            depth_write_enabled: depth.depth_write_enabled,
            depth_compare: depth.depth_compare,
            stencil: wgpu::StencilState {
                front: depth.stencil_front,
                back: depth.stencil_back,
                read_mask: depth.stencil_read_mask,
                write_mask: depth.stencil_write_mask,
            },
            bias: wgpu::DepthBiasState {
                constant: depth.depth_bias,
                slope_scale: depth.depth_bias_slope_scale,
                clamp: depth.depth_bias_clamp,
            },
        });
        Ok(
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(&self.label),
                layout,
                vertex: wgpu::VertexState {
                    module: vertex_module,
                    entry_point: self.vertex.entry_point.as_deref(),
                    compilation_options: Default::default(),
                    buffers: &buffers,
                },
                primitive,
                depth_stencil,
                multisample: wgpu::MultisampleState {
                    count: self.samples.count,
                    mask: self.samples.mask,
                    alpha_to_coverage_enabled: self.samples.alpha_to_coverage_enabled,
                },
                fragment,
                multiview_mask: None,
                cache: None,
            }),
        )
    }
}
