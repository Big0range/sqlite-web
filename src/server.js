import { resolve } from 'node:path';
import { createApp } from './app.js';

const port = Number.parseInt(process.env.PORT, 10) || 3000;
const host = process.env.HOST || '127.0.0.1';
const app = createApp({
  registryPath: resolve('data', 'databases.json'),
  authPath: resolve('auth.json')
});

app.listen(port, host, () => {
  console.log(`SQLite Web 管理服务已启动：http://${host}:${port}`);
});
