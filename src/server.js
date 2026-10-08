import { resolve } from 'node:path';
import { createApp } from './app.js';

const port = Number.parseInt(process.env.PORT, 10) || 3000;
const app = createApp({
  registryPath: resolve('data', 'databases.json'),
  authPath: resolve('auth.json')
});

app.listen(port, () => {
  console.log(`SQLite Web 管理服务已启动：http://localhost:${port}`);
});
