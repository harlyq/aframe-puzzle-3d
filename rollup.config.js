// rollup.config.js
import resolve from 'rollup-plugin-node-resolve';

export default {
  input: 'src/index.js',
  output: {
    file: 'dist/aframe-puzzle-3d.js',
    format: 'umd'
  },
  plugins: [ resolve() ]
};