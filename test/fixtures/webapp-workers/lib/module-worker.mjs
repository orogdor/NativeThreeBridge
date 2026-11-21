// Module worker: static imports resolve like the page's modules.
import { double } from './math.mjs';

self.onmessage = ({ data }) => postMessage(`module:${double(data)}`);
