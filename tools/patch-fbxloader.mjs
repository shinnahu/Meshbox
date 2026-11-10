// Copies three's FBXLoader into src/web/js/vendor and adds topology bookkeeping the viewer needs:
// true polygon / control-point counts (what Blender and Tripo call Faces / Vertices) and the polygon
// outline edges, so wireframes can show quads instead of triangulated diagonals.
// Run again after upgrading three: `node tools/patch-fbxloader.mjs`.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules/three/examples/jsm/loaders/FBXLoader.js');
const out = join(root, 'src/web/js/vendor/FBXLoader.js');
let code = readFileSync(src, 'utf8');

function replace(from, to) {
  if (!code.includes(from)) throw new Error('FBXLoader patch target not found:\n' + from);
  code = code.replace(from, to);
}

replace("from '../libs/fflate.module.js'", "from 'three/examples/jsm/libs/fflate.module.js'");
replace("from '../curves/NURBSCurve.js'", "from 'three/examples/jsm/curves/NURBSCurve.js'");

replace(`			vertexWeights: [],
			weightsIndices: [],
		};`, `			vertexWeights: [],
			weightsIndices: [],
			polyEdges: [], // patched: polygon outline edges as vertex index pairs
			polygonCount: 0, // patched
		};`);

replace(`		for ( const [ i0, i1, i2 ] of triangles ) {

			buffers.vertex.push( geoInfo.vertexPositions[ facePositionIndexes[ i0 * 3 ] ] );`,
`		// patched: remember the polygon outline so wireframes can hide triangulation diagonals
		if ( buffers.polyEdges ) {

			const base = buffers.vertex.length / 3;
			const corner = new Array( faceLength );
			triangles.forEach( ( tri, t ) => {

				for ( let k = 0; k < 3; k ++ ) if ( corner[ tri[ k ] ] === undefined ) corner[ tri[ k ] ] = base + t * 3 + k;

			} );
			for ( let j = 0; j < faceLength; j ++ ) {

				const a = corner[ j ], b = corner[ ( j + 1 ) % faceLength ];
				if ( a !== undefined && b !== undefined ) buffers.polyEdges.push( a, b );

			}
			buffers.polygonCount ++;

		}

		for ( const [ i0, i1, i2 ] of triangles ) {

			buffers.vertex.push( geoInfo.vertexPositions[ facePositionIndexes[ i0 * 3 ] ] );`);

replace(`		this.addMorphTargets( geo, geoNode, morphTargets, preTransform );

		return geo;`, `		this.addMorphTargets( geo, geoNode, morphTargets, preTransform );

		// patched: topology info for the viewer
		geo.userData.polygonCount = buffers.polygonCount;
		geo.userData.controlPoints = geoInfo.vertexPositions.length / 3;
		if ( buffers.polyEdges.length > 0 ) geo.userData.polyEdges = new Uint32Array( buffers.polyEdges );

		return geo;`);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, '// Patched copy of three/examples/jsm/loaders/FBXLoader.js - see tools/patch-fbxloader.mjs\n' + code);
console.log('wrote', out);
