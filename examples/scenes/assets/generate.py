import json
import struct
from pathlib import Path

positions = [0, 1, 0, -1, -1, 1, 1, -1, 1, 0, -1, -1]
indices = [0, 1, 2, 0, 2, 3, 0, 3, 1, 1, 3, 2]
binary = struct.pack('<12f12H', *positions, *indices)
model = {
    'asset': {'version': '2.0', 'generator': '3js-compiled'},
    'scene': 0,
    'scenes': [{'nodes': [0]}],
    'nodes': [{'mesh': 0}],
    'meshes': [{'primitives': [{'attributes': {'POSITION': 0}, 'indices': 1, 'material': 0}]}],
    'materials': [{'pbrMetallicRoughness': {'baseColorFactor': [0.25, 0.7, 0.85, 1], 'metallicFactor': 0.1, 'roughnessFactor': 0.45}}],
    'buffers': [{'byteLength': len(binary)}],
    'bufferViews': [{'buffer': 0, 'byteOffset': 0, 'byteLength': 48}, {'buffer': 0, 'byteOffset': 48, 'byteLength': 24}],
    'accessors': [
        {'bufferView': 0, 'componentType': 5126, 'count': 4, 'type': 'VEC3', 'min': [-1, -1, -1], 'max': [1, 1, 1]},
        {'bufferView': 1, 'componentType': 5123, 'count': 12, 'type': 'SCALAR'},
    ],
}
encoded = json.dumps(model, separators=(',', ':')).encode('utf-8')
encoded += b' ' * (-len(encoded) % 4)
binary += b'\0' * (-len(binary) % 4)
body = struct.pack('<I4s', len(encoded), b'JSON') + encoded + struct.pack('<I4s', len(binary), b'BIN\0') + binary
Path(__file__).with_name('tetrahedron.glb').write_bytes(struct.pack('<4sII', b'glTF', 2, 12 + len(body)) + body)
