import { createServer } from 'node:http';
import { handle } from './server.mjs';

createServer(handle).listen(3000);
