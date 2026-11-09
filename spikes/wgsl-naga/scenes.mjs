// One small scene per feature. Each builder returns
// { scene, camera } | { pipeline } | { compute, scene, camera }, plus optional frames/beforeFrame.

import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js';
import { motionBlur } from 'three/addons/tsl/display/MotionBlur.js';
import { afterImage } from 'three/addons/tsl/display/AfterImageNode.js';
import { outline } from 'three/addons/tsl/display/OutlineNode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import { gaussianBlur } from 'three/addons/tsl/display/GaussianBlurNode.js';

function dataTexture( THREE, size = 16, channels = 4, color = [ 255, 128, 64, 255 ] ) {

	const data = new Uint8Array( size * size * 4 );
	for ( let i = 0; i < size * size; i ++ ) {

		const checker = ( ( i % size ) + Math.floor( i / size ) ) % 2;
		data[ i * 4 + 0 ] = checker ? color[ 0 ] : 32;
		data[ i * 4 + 1 ] = checker ? color[ 1 ] : 32;
		data[ i * 4 + 2 ] = checker ? color[ 2 ] : 32;
		data[ i * 4 + 3 ] = color[ 3 ];

	}

	const tex = new THREE.DataTexture( data, size, size, THREE.RGBAFormat );
	tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
	tex.generateMipmaps = true;
	tex.minFilter = THREE.LinearMipmapLinearFilter;
	tex.needsUpdate = true;
	return tex;

}

function base( THREE, { lights = true } = {} ) {

	const scene = new THREE.Scene();
	scene.background = new THREE.Color( 0x202030 );
	const camera = new THREE.PerspectiveCamera( 50, 1, 0.1, 100 );
	camera.position.set( 0, 1.5, 5 );
	camera.lookAt( 0, 0, 0 );

	if ( lights ) {

		const dir = new THREE.DirectionalLight( 0xffffff, 2 );
		dir.position.set( 3, 5, 2 );
		scene.add( dir, new THREE.AmbientLight( 0x404040, 1 ) );

	}

	return { scene, camera };

}

function meshScene( THREE, material, opts = {} ) {

	const { scene, camera } = base( THREE, opts );
	const geo = opts.geometry ?? new THREE.TorusKnotGeometry( 0.8, 0.3, 64, 12 );
	const mesh = new THREE.Mesh( geo, material );
	scene.add( mesh );
	if ( opts.floor ) {

		const floor = new THREE.Mesh( new THREE.PlaneGeometry( 10, 10 ), new THREE.MeshStandardMaterial( { color: 0x888888 } ) );
		floor.rotation.x = - Math.PI / 2;
		floor.position.y = - 1.3;
		floor.receiveShadow = true;
		scene.add( floor );

	}

	return { scene, camera, mesh };

}

function shadowScene( THREE, renderer, shadowType, lightKind ) {

	renderer.shadowMap.enabled = true;
	renderer.shadowMap.type = shadowType;
	const { scene, camera, mesh } = meshScene( THREE, new THREE.MeshStandardMaterial( { color: 0x44aa88 } ), { lights: false, floor: true } );
	mesh.castShadow = true;
	let light;
	if ( lightKind === 'dir' ) {

		light = new THREE.DirectionalLight( 0xffffff, 3 );
		light.position.set( 3, 5, 2 );

	} else if ( lightKind === 'point' ) {

		light = new THREE.PointLight( 0xffffff, 30 );
		light.position.set( 2, 3, 2 );

	} else {

		light = new THREE.SpotLight( 0xffffff, 40, 0, Math.PI / 5, 0.3 );
		light.position.set( 2, 4, 2 );

	}

	light.castShadow = true;
	light.shadow.mapSize.set( 512, 512 );
	scene.add( light, new THREE.AmbientLight( 0x404040 ) );
	return { scene, camera };

}

function postBase( THREE, TSL, renderer, { mrt } = {} ) {

	const { scene, camera, mesh } = meshScene( THREE, new THREE.MeshStandardMaterial( { color: 0xff6633, roughness: 0.3, emissive: 0x331100 } ), { floor: true } );
	const pipeline = new THREE.RenderPipeline( renderer );
	const scenePass = TSL.pass( scene, camera );
	if ( mrt ) scenePass.setMRT( mrt );
	return { scene, camera, mesh, pipeline, scenePass, color: scenePass.getTextureNode( 'output' ) };

}

export const scenes = {

	// --- basic material family ---
	'mat/basic': ( { THREE } ) => meshScene( THREE, new THREE.MeshBasicMaterial( { color: 0xff0000 } ) ),
	'mat/basic-map-vertexcolors': ( { THREE } ) => {

		const geo = new THREE.BoxGeometry();
		const colors = new Float32Array( geo.attributes.position.count * 3 ).fill( 0.5 );
		geo.setAttribute( 'color', new THREE.BufferAttribute( colors, 3 ) );
		return meshScene( THREE, new THREE.MeshBasicMaterial( { map: dataTexture( THREE ), vertexColors: true } ), { geometry: geo } );

	},
	'mat/lambert': ( { THREE } ) => meshScene( THREE, new THREE.MeshLambertMaterial( { color: 0x00ff00 } ) ),
	'mat/phong': ( { THREE } ) => meshScene( THREE, new THREE.MeshPhongMaterial( { color: 0x0000ff, shininess: 80, specular: 0x222222 } ) ),
	'mat/standard': ( { THREE } ) => meshScene( THREE, new THREE.MeshStandardMaterial( { color: 0xffffff, roughness: 0.5, metalness: 0.5 } ) ),
	'mat/standard-maps': ( { THREE } ) => meshScene( THREE, new THREE.MeshStandardMaterial( {
		map: dataTexture( THREE ),
		normalMap: dataTexture( THREE, 16, 4, [ 128, 128, 255, 255 ] ),
		roughnessMap: dataTexture( THREE ),
		metalnessMap: dataTexture( THREE ),
		aoMap: dataTexture( THREE ),
		emissiveMap: dataTexture( THREE ),
		emissive: 0x111111,
		bumpMap: dataTexture( THREE ),
		displacementMap: dataTexture( THREE ),
		displacementScale: 0.05
	} ) ),
	'mat/physical': ( { THREE } ) => meshScene( THREE, new THREE.MeshPhysicalMaterial( { color: 0xffffff, roughness: 0.2, metalness: 0.1 } ) ),
	'mat/physical-clearcoat': ( { THREE } ) => meshScene( THREE, new THREE.MeshPhysicalMaterial( { clearcoat: 1, clearcoatRoughness: 0.1, clearcoatNormalMap: dataTexture( THREE, 16, 4, [ 128, 128, 255, 255 ] ) } ) ),
	'mat/physical-transmission': ( { THREE } ) => meshScene( THREE, new THREE.MeshPhysicalMaterial( { transmission: 1, thickness: 0.5, roughness: 0.1, ior: 1.5, dispersion: 0.2 } ), { floor: true } ),
	'mat/physical-iridescence': ( { THREE } ) => meshScene( THREE, new THREE.MeshPhysicalMaterial( { iridescence: 1, iridescenceIOR: 1.3, iridescenceThicknessMinimum: 100, iridescenceThicknessMaximum: 400 } ) ),
	'mat/physical-sheen': ( { THREE } ) => meshScene( THREE, new THREE.MeshPhysicalMaterial( { sheen: 1, sheenColor: 0xff00ff, sheenRoughness: 0.5 } ) ),
	'mat/physical-anisotropy': ( { THREE } ) => meshScene( THREE, new THREE.MeshPhysicalMaterial( { anisotropy: 0.8, anisotropyRotation: 0.5, roughness: 0.3, metalness: 1 } ) ),
	'mat/toon': ( { THREE } ) => meshScene( THREE, new THREE.MeshToonMaterial( { color: 0xffaa00 } ) ),
	'mat/normal': ( { THREE } ) => meshScene( THREE, new THREE.MeshNormalMaterial() ),
	'mat/matcap': ( { THREE } ) => meshScene( THREE, new THREE.MeshMatcapMaterial( { matcap: dataTexture( THREE ) } ) ),
	'mat/line-basic': ( { THREE } ) => {

		const { scene, camera } = base( THREE );
		const geo = new THREE.BufferGeometry().setFromPoints( [ new THREE.Vector3( - 1, 0, 0 ), new THREE.Vector3( 0, 1, 0 ), new THREE.Vector3( 1, 0, 0 ) ] );
		scene.add( new THREE.Line( geo, new THREE.LineBasicMaterial( { color: 0xffffff } ) ) );
		const dashed = new THREE.Line( geo.clone(), new THREE.LineDashedMaterial( { dashSize: 0.1, gapSize: 0.05 } ) );
		dashed.computeLineDistances();
		scene.add( dashed );
		return { scene, camera };

	},
	'mat/points': ( { THREE } ) => {

		const { scene, camera } = base( THREE );
		const geo = new THREE.BufferGeometry();
		geo.setAttribute( 'position', new THREE.Float32BufferAttribute( Array.from( { length: 300 }, () => Math.random() * 2 - 1 ), 3 ) );
		geo.setAttribute( 'uv', new THREE.Float32BufferAttribute( new Array( 200 ).fill( 0.5 ), 2 ) );
		scene.add( new THREE.Points( geo, new THREE.PointsMaterial( { size: 0.05, map: dataTexture( THREE ), transparent: true } ) ) );
		return { scene, camera };

	},
	'mat/sprite': ( { THREE } ) => {

		const { scene, camera } = base( THREE );
		scene.add( new THREE.Sprite( new THREE.SpriteMaterial( { map: dataTexture( THREE ), color: 0xffffff } ) ) );
		return { scene, camera };

	},

	// --- environment / fog / alpha ---
	'env/pmrem-room': ( { THREE, renderer } ) => {

		const { scene, camera } = meshScene( THREE, new THREE.MeshStandardMaterial( { roughness: 0.2, metalness: 1 } ), { lights: false } );
		const pmrem = new THREE.PMREMGenerator( renderer );
		scene.environment = pmrem.fromScene( new RoomEnvironment(), 0.04 ).texture;
		scene.background = scene.environment;
		return { scene, camera };

	},
	'env/fog': ( { THREE } ) => {

		const ctx = meshScene( THREE, new THREE.MeshStandardMaterial( { color: 0xffffff } ) );
		ctx.scene.fog = new THREE.Fog( 0x202030, 2, 8 );
		return ctx;

	},
	'env/fog-exp2': ( { THREE } ) => {

		const ctx = meshScene( THREE, new THREE.MeshLambertMaterial( { color: 0xffffff } ) );
		ctx.scene.fog = new THREE.FogExp2( 0x202030, 0.2 );
		return ctx;

	},
	'alpha/test': ( { THREE } ) => meshScene( THREE, new THREE.MeshStandardMaterial( { map: dataTexture( THREE, 16, 4, [ 255, 255, 255, 0 ] ), alphaTest: 0.5, side: THREE.DoubleSide } ) ),
	'alpha/hash': ( { THREE } ) => meshScene( THREE, new THREE.MeshStandardMaterial( { opacity: 0.5, alphaHash: true } ) ),
	'alpha/transparent': ( { THREE } ) => meshScene( THREE, new THREE.MeshStandardMaterial( { opacity: 0.5, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending } ) ),

	// --- lights ---
	'light/point-spot-hemi': ( { THREE } ) => {

		const { scene, camera } = meshScene( THREE, new THREE.MeshStandardMaterial( { color: 0xffffff } ), { lights: false } );
		const point = new THREE.PointLight( 0xff0000, 20 );
		point.position.set( 2, 2, 2 );
		const spot = new THREE.SpotLight( 0x00ff00, 30, 0, Math.PI / 6, 0.5 );
		spot.position.set( - 2, 3, 2 );
		scene.add( point, spot, new THREE.HemisphereLight( 0x8888ff, 0x442200, 1 ) );
		return { scene, camera };

	},
	'light/rectarea': async ( { THREE } ) => {

		const { RectAreaLightTexturesLib } = await import( 'three/addons/lights/RectAreaLightTexturesLib.js' );
		THREE.RectAreaLightNode.setLTC( RectAreaLightTexturesLib.init() );
		const { scene, camera } = meshScene( THREE, new THREE.MeshStandardMaterial( { color: 0xffffff, roughness: 0.3 } ), { lights: false } );
		const rect = new THREE.RectAreaLight( 0xffffff, 5, 2, 2 );
		rect.position.set( 0, 2, 2 );
		rect.lookAt( 0, 0, 0 );
		scene.add( rect );
		return { scene, camera };

	},

	// --- shadows ---
	'shadow/dir-pcf': ( { THREE, renderer } ) => shadowScene( THREE, renderer, THREE.PCFShadowMap, 'dir' ),
	'shadow/dir-basic': ( { THREE, renderer } ) => shadowScene( THREE, renderer, THREE.BasicShadowMap, 'dir' ),
	'shadow/dir-vsm': ( { THREE, renderer } ) => shadowScene( THREE, renderer, THREE.VSMShadowMap, 'dir' ),
	'shadow/point': ( { THREE, renderer } ) => shadowScene( THREE, renderer, THREE.PCFShadowMap, 'point' ),
	'shadow/spot': ( { THREE, renderer } ) => shadowScene( THREE, renderer, THREE.PCFShadowMap, 'spot' ),

	// --- geometry / object types ---
	'obj/instanced': ( { THREE } ) => {

		const { scene, camera } = base( THREE );
		const mesh = new THREE.InstancedMesh( new THREE.BoxGeometry( 0.2, 0.2, 0.2 ), new THREE.MeshStandardMaterial(), 100 );
		const m = new THREE.Matrix4();
		for ( let i = 0; i < 100; i ++ ) {

			m.setPosition( ( i % 10 ) * 0.3 - 1.5, Math.floor( i / 10 ) * 0.3 - 1.5, 0 );
			mesh.setMatrixAt( i, m );
			mesh.setColorAt( i, new THREE.Color( i / 100, 0.5, 1 - i / 100 ) );

		}

		scene.add( mesh );
		return { scene, camera };

	},
	'obj/batched': ( { THREE } ) => {

		const { scene, camera } = base( THREE );
		const batched = new THREE.BatchedMesh( 10, 5000, 10000, new THREE.MeshStandardMaterial() );
		const box = batched.addGeometry( new THREE.BoxGeometry( 0.3, 0.3, 0.3 ) );
		const sphere = batched.addGeometry( new THREE.SphereGeometry( 0.2, 12, 8 ) );
		const m = new THREE.Matrix4();
		for ( let i = 0; i < 6; i ++ ) {

			const id = batched.addInstance( i % 2 ? box : sphere );
			batched.setMatrixAt( id, m.makeTranslation( i * 0.5 - 1.25, 0, 0 ) );
			batched.setColorAt( id, new THREE.Color( 1, i / 6, 0 ) );

		}

		scene.add( batched );
		return { scene, camera };

	},
	'obj/skinned': ( { THREE } ) => {

		const { scene, camera } = base( THREE );
		const geo = new THREE.CylinderGeometry( 0.2, 0.2, 2, 8, 8 );
		const pos = geo.attributes.position;
		const skinIndex = [], skinWeight = [];
		for ( let i = 0; i < pos.count; i ++ ) {

			const w = ( pos.getY( i ) + 1 ) / 2;
			skinIndex.push( 0, 1, 0, 0 );
			skinWeight.push( 1 - w, w, 0, 0 );

		}

		geo.setAttribute( 'skinIndex', new THREE.Uint16BufferAttribute( skinIndex, 4 ) );
		geo.setAttribute( 'skinWeight', new THREE.Float32BufferAttribute( skinWeight, 4 ) );
		const root = new THREE.Bone(), tip = new THREE.Bone();
		root.position.y = - 1;
		tip.position.y = 2;
		root.add( tip );
		const mesh = new THREE.SkinnedMesh( geo, new THREE.MeshStandardMaterial( { color: 0xffcc00 } ) );
		mesh.add( root );
		mesh.bind( new THREE.Skeleton( [ root, tip ] ) );
		tip.rotation.z = 0.5;
		scene.add( mesh );
		return { scene, camera };

	},
	'obj/morph': ( { THREE } ) => {

		const geo = new THREE.BoxGeometry( 1, 1, 1, 4, 4, 4 );
		const target = geo.attributes.position.clone();
		for ( let i = 0; i < target.count; i ++ ) target.setY( i, target.getY( i ) * 2 );
		geo.morphAttributes.position = [ target ];
		const ctx = meshScene( THREE, new THREE.MeshStandardMaterial( { color: 0x88ccff } ), { geometry: geo } );
		ctx.mesh.morphTargetInfluences[ 0 ] = 0.5;
		return ctx;

	},
	'obj/clipping': ( { THREE, renderer } ) => {

		renderer.localClippingEnabled = true;
		return meshScene( THREE, new THREE.MeshStandardMaterial( { clippingPlanes: [ new THREE.Plane( new THREE.Vector3( 1, 0, 0 ), 0 ), new THREE.Plane( new THREE.Vector3( 0, - 1, 0 ), 0.5 ) ], side: THREE.DoubleSide } ) );

	},

	// --- custom TSL ---
	'tsl/custom-material': ( { THREE, TSL } ) => {

		const { Fn, color, mix, sin, cos, time, positionLocal, normalLocal, normalWorld, uv, vec3, float, smoothstep, fract, texture, triplanarTexture, length } = TSL;
		const mat = new THREE.MeshStandardNodeMaterial();
		const tex = dataTexture( THREE );
		mat.colorNode = Fn( () => {

			const stripes = smoothstep( 0.4, 0.6, fract( uv().x.mul( 10 ) ) );
			const base = mix( color( 0xff0000 ), color( 0x0000ff ), sin( time ).mul( 0.5 ).add( 0.5 ) );
			return mix( base, texture( tex, uv().mul( 2 ) ).rgb, stripes ).mul( normalWorld.y.mul( 0.5 ).add( 0.5 ) );

		} )();
		mat.positionNode = positionLocal.add( normalLocal.mul( sin( time.add( positionLocal.y.mul( 4 ) ) ).mul( 0.05 ) ) );
		mat.roughnessNode = float( 0.5 ).add( cos( length( positionLocal ) ).mul( 0.2 ) );
		mat.emissiveNode = triplanarTexture( tex ).rgb.mul( 0.1 ).add( vec3( 0 ) );
		return meshScene( THREE, mat );

	},
	'tsl/compute-instanced': ( { THREE, TSL } ) => {

		const { Fn, instancedArray, instanceIndex, float, vec3, hash, time, positionLocal, sin } = TSL;
		const count = 1024;
		const positions = instancedArray( count, 'vec3' );
		const velocities = instancedArray( count, 'vec3' );
		const init = Fn( () => {

			const p = positions.element( instanceIndex );
			p.assign( vec3( hash( instanceIndex ), hash( instanceIndex.add( 1 ) ), hash( instanceIndex.add( 2 ) ) ).mul( 2 ).sub( 1 ) );
			velocities.element( instanceIndex ).assign( vec3( 0, float( 0.01 ), 0 ) );

		} )().compute( count );
		const update = Fn( () => {

			const p = positions.element( instanceIndex );
			const v = velocities.element( instanceIndex );
			p.addAssign( v.mul( sin( time ) ) );
			p.y.assign( p.y.mod( 2 ).sub( 1 ) );

		} )().compute( count );
		const { scene, camera } = base( THREE );
		const mat = new THREE.MeshStandardNodeMaterial( { color: 0x66ccff } );
		mat.positionNode = positionLocal.add( positions.element( instanceIndex ) );
		const mesh = new THREE.InstancedMesh( new THREE.SphereGeometry( 0.02, 6, 4 ), mat, count );
		scene.add( mesh );
		let first = true;
		return {
			scene, camera, get compute() {

				const c = first ? init : update;
				first = false;
				return c;

			}
		};

	},
	'tsl/compute-atomics-storage-texture': ( { THREE, TSL } ) => {

		const { Fn, instanceIndex, storage, atomicAdd, uvec2, textureStore, vec4, uint, float } = TSL;
		const counter = new THREE.StorageBufferAttribute( new Uint32Array( 1 ), 1 );
		const counterNode = storage( counter, 'uint', 1 ).toAtomic();
		const storageTex = new THREE.StorageTexture( 64, 64 );
		const compute = Fn( () => {

			atomicAdd( counterNode.element( 0 ), uint( 1 ) );
			const x = instanceIndex.mod( 64 ), y = instanceIndex.div( 64 );
			textureStore( storageTex, uvec2( x, y ), vec4( float( x ).div( 64 ), float( y ).div( 64 ), 0, 1 ) ).toWriteOnly();

		} )().compute( 64 * 64 );
		const { scene, camera } = meshScene( THREE, new THREE.MeshBasicMaterial( { map: storageTex } ), { geometry: new THREE.PlaneGeometry( 2, 2 ) } );
		return { scene, camera, compute };

	},

	// --- post-processing (TSL RenderPipeline) ---
	'post/passthrough-tonemap': ( { THREE, TSL, renderer } ) => {

		renderer.toneMapping = THREE.ACESFilmicToneMapping;
		const p = postBase( THREE, TSL, renderer );
		p.pipeline.outputNode = p.color;
		return p;

	},
	'post/bloom': ( { THREE, TSL, renderer } ) => {

		const p = postBase( THREE, TSL, renderer );
		p.pipeline.outputNode = p.color.add( bloom( p.color, 1, 0.4, 0.2 ) );
		return p;

	},
	'post/fxaa': ( { THREE, TSL, renderer } ) => {

		const p = postBase( THREE, TSL, renderer );
		p.pipeline.outputColorTransform = false;
		p.pipeline.outputNode = fxaa( TSL.renderOutput( p.color ) );
		return p;

	},
	'post/smaa': ( { THREE, TSL, renderer } ) => {

		const p = postBase( THREE, TSL, renderer );
		p.pipeline.outputColorTransform = false;
		p.pipeline.outputNode = smaa( TSL.renderOutput( p.color ) );
		return p;

	},
	'post/gtao': ( { THREE, TSL, renderer } ) => {

		const { mrt, output, normalView, packNormalToRGB, unpackRGBToNormal, sample } = TSL;
		const p = postBase( THREE, TSL, renderer, { mrt: mrt( { output, normal: packNormalToRGB( normalView ) } ) } );
		const depth = p.scenePass.getTextureNode( 'depth' );
		const normalTex = p.scenePass.getTextureNode( 'normal' );
		const normal = sample( ( uv ) => unpackRGBToNormal( normalTex.sample( uv ) ) );
		const aoPass = ao( depth, normal, p.camera );
		p.pipeline.outputNode = p.color.mul( aoPass.getTextureNode().r );
		return p;

	},
	'post/dof': ( { THREE, TSL, renderer } ) => {

		const p = postBase( THREE, TSL, renderer );
		p.pipeline.outputNode = dof( p.color, p.scenePass.getViewZNode(), 5, 2, 1 );
		return p;

	},
	'post/motionblur-velocity': ( { THREE, TSL, renderer } ) => {

		const { mrt, output, velocity } = TSL;
		const p = postBase( THREE, TSL, renderer, { mrt: mrt( { output, velocity } ) } );
		p.pipeline.outputNode = motionBlur( p.color, p.scenePass.getTextureNode( 'velocity' ).mul( 1 ) );
		p.frames = 3;
		p.beforeFrame = ( i ) => p.mesh.rotation.y = i * 0.2;
		return p;

	},
	'post/afterimage': ( { THREE, TSL, renderer } ) => {

		const p = postBase( THREE, TSL, renderer );
		p.pipeline.outputNode = afterImage( p.color, 0.9 );
		p.frames = 3;
		return p;

	},
	'post/outline': ( { THREE, TSL, renderer } ) => {

		const p = postBase( THREE, TSL, renderer );
		const outlinePass = outline( p.scene, p.camera, { selectedObjects: [ p.mesh ], edgeThickness: TSL.uniform( 1 ), edgeGlow: TSL.uniform( 0 ) } );
		const { visibleEdge, hiddenEdge } = outlinePass;
		const edge = visibleEdge.mul( TSL.color( 0xffffff ) ).add( hiddenEdge.mul( TSL.color( 0x4e3636 ) ) ).mul( 3 );
		p.pipeline.outputNode = edge.add( p.color );
		return p;

	},
	'post/traa': ( { THREE, TSL, renderer } ) => {

		const { mrt, output, velocity } = TSL;
		const p = postBase( THREE, TSL, renderer, { mrt: mrt( { output, velocity } ) } );
		p.pipeline.outputNode = traa( p.color, p.scenePass.getTextureNode( 'depth' ), p.scenePass.getTextureNode( 'velocity' ), p.camera );
		p.frames = 3;
		return p;

	},
	'post/ssr': ( { THREE, TSL, renderer } ) => {

		const { mrt, output, normalView, metalness, roughness, packNormalToRGB, unpackRGBToNormal, sample, vec2 } = TSL;
		const p = postBase( THREE, TSL, renderer, { mrt: mrt( { output, normal: packNormalToRGB( normalView ), metalrough: vec2( metalness, roughness ) } ) } );
		const normalTex = p.scenePass.getTextureNode( 'normal' );
		const normal = sample( ( uv ) => unpackRGBToNormal( normalTex.sample( uv ) ) );
		const mr = p.scenePass.getTextureNode( 'metalrough' );
		const ssrPass = ssr( p.color, p.scenePass.getTextureNode( 'depth' ), normal, { metalnessNode: mr.r, roughnessNode: mr.g, camera: p.camera } );
		p.pipeline.outputNode = TSL.blendColor( p.color, ssrPass );
		return p;

	},
	'post/gaussian-blur': ( { THREE, TSL, renderer } ) => {

		const p = postBase( THREE, TSL, renderer );
		p.pipeline.outputNode = gaussianBlur( p.color, TSL.vec2( 1, 1 ), 4 );
		return p;

	}

};
