import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/app.js';

async function startTestServer() {
  const directory = mkdtempSync(join(tmpdir(), 'sqlite-web-manager-'));
  const databasePath = join(directory, 'sample.sqlite');
  const authPath = join(directory, 'auth.json');
  writeFileSync(authPath, JSON.stringify({ username: 'admin', password: 'test-password' }));
  const database = new DatabaseSync(databasePath);
  database.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER)');
  database.close();

  const app = createApp({
    registryPath: join(directory, 'databases.json'),
    authPath
  });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test-password' })
  });
  const session = login.headers.get('set-cookie')?.split(';')[0];

  return {
    directory,
    databasePath,
    request: (path, options = {}) => fetch(`${origin}${path}`, {
      ...options,
      headers: { cookie: session, ...options.headers }
    }),
    unauthenticatedRequest: (path, options) => fetch(`${origin}${path}`, options),
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

function registerDatabase(service, { name, path, uploadPath }) {
  const form = new FormData();
  form.set('name', name);
  if (uploadPath) {
    form.set('source', 'upload');
    form.set('databaseFile', new Blob([readFileSync(uploadPath)]), 'uploaded.sqlite');
  } else {
    form.set('source', 'path');
    form.set('path', path);
  }
  return service.request('/api/databases', { method: 'POST', body: form });
}

test('未登录时管理 API 会拒绝访问，正确凭据可建立会话', async (context) => {
  const service = await startTestServer();
  context.after(() => service.close());

  const unauthorized = await service.unauthenticatedRequest('/api/databases');
  assert.equal(unauthorized.status, 401);
  const loginPage = await service.unauthenticatedRequest('/login');
  assert.equal(loginPage.status, 200);
  assert.match(await loginPage.text(), /登录管理台/);

  const rejected = await service.unauthenticatedRequest('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'wrong-password' })
  });
  assert.equal(rejected.status, 401);

  const login = await service.unauthenticatedRequest('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test-password' })
  });
  assert.equal(login.status, 204);
  const session = login.headers.get('set-cookie')?.split(';')[0];
  const authorized = await service.unauthenticatedRequest('/api/databases', {
    headers: { cookie: session }
  });
  assert.equal(authorized.status, 200);
});

test('提交登记表单时上传 SQLite 文件并登记', async (context) => {
  const service = await startTestServer();
  context.after(() => service.close());

  const registered = await registerDatabase(service, {
    name: '上传测试库',
    uploadPath: service.databasePath
  });
  assert.equal(registered.status, 201);
  const database = (await registered.json()).database;
  assert.equal(database.name, '上传测试库');
  assert.ok(existsSync(database.path));
});

test('取消登记会删除上传的 SQLite 文件', async (context) => {
  const service = await startTestServer();
  context.after(() => service.close());

  const registered = await registerDatabase(service, {
    name: '上传测试库',
    uploadPath: service.databasePath
  });
  const database = (await registered.json()).database;
  assert.ok(existsSync(database.path));

  const removed = await service.request(`/api/databases/${database.id}`, {
    method: 'DELETE'
  });
  assert.equal(removed.status, 204);
  assert.equal(existsSync(database.path), false);
});

test('取消登记不会删除路径来源的 SQLite 文件', async (context) => {
  const service = await startTestServer();
  context.after(() => service.close());

  const registered = await registerDatabase(service, {
    name: '路径测试库',
    path: service.databasePath
  });
  const database = (await registered.json()).database;

  const removed = await service.request(`/api/databases/${database.id}`, {
    method: 'DELETE'
  });
  assert.equal(removed.status, 204);
  assert.ok(existsSync(service.databasePath));
});

test('相对路径会原样登记并在读取时解析', async (context) => {
  const service = await startTestServer();
  context.after(() => service.close());
  const path = relative(process.cwd(), service.databasePath);

  const registered = await registerDatabase(service, {
    name: '相对路径测试库',
    path
  });
  assert.equal(registered.status, 201);
  const database = (await registered.json()).database;
  assert.equal(database.path, path);

  const tables = await service.request(`/api/databases/${database.id}/tables`);
  assert.equal(tables.status, 200);
  assert.deepEqual((await tables.json()).tables, [{ name: 'users' }]);
});

test('登记数据库并完成用户记录增删改查', async (context) => {
  const service = await startTestServer();
  context.after(() => service.close());

  const registered = await registerDatabase(service, {
    name: '测试库',
    path: service.databasePath
  });
  assert.equal(registered.status, 201);
  const database = (await registered.json()).database;

  const tables = await service.request(`/api/databases/${database.id}/tables`);
  assert.deepEqual((await tables.json()).tables, [{ name: 'users' }]);

  const created = await service.request(`/api/databases/${database.id}/tables/users/rows`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ values: { name: '小橘', age: 3 } })
  });
  assert.equal(created.status, 201);

  const initialRows = await service.request(`/api/databases/${database.id}/tables/users`);
  assert.deepEqual((await initialRows.json()).rows, [{ id: 1, name: '小橘', age: 3 }]);

  const updated = await service.request(`/api/databases/${database.id}/tables/users/rows`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: { id: 1 }, values: { name: '主人' } })
  });
  assert.equal(updated.status, 204);

  const removed = await service.request(`/api/databases/${database.id}/tables/users/rows`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: { id: 1 } })
  });
  assert.equal(removed.status, 204);

  const finalRows = await service.request(`/api/databases/${database.id}/tables/users`);
  assert.equal((await finalRows.json()).total, 0);
});

test('编辑表设计会保留已有数据并应用字段变更', async (context) => {
  const service = await startTestServer();
  context.after(() => service.close());

  const registered = await registerDatabase(service, {
    name: '测试库',
    path: service.databasePath
  });
  const database = (await registered.json()).database;

  await service.request(`/api/databases/${database.id}/tables/users/rows`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ values: { name: '小橘', age: 3 } })
  });

  const changed = await service.request(`/api/databases/${database.id}/tables/users/schema`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      columns: [
        { name: 'id', type: 'INTEGER', sourceName: 'id', primaryKey: true, notNull: false },
        { name: 'display_name', type: 'TEXT', sourceName: 'name', primaryKey: false, notNull: true },
        { name: 'age', type: 'TEXT', sourceName: 'age', primaryKey: false, notNull: false },
        { name: 'status', type: 'TEXT', sourceName: '', primaryKey: false, notNull: true, defaultValue: "'new'" },
        { name: 'created_at', type: 'TEXT', sourceName: '', primaryKey: false, notNull: true, defaultValue: "datetime('now')" }
      ]
    })
  });
  assert.equal(changed.status, 200);

  const data = await service.request(`/api/databases/${database.id}/tables/users`);
  const payload = await data.json();
  assert.deepEqual(payload.columns.map((column) => ({
    name: column.name,
    type: column.type,
    notNull: column.notNull,
    primaryKeyOrder: column.primaryKeyOrder
  })), [
    { name: 'id', type: 'INTEGER', notNull: false, primaryKeyOrder: 1 },
    { name: 'display_name', type: 'TEXT', notNull: true, primaryKeyOrder: 0 },
    { name: 'age', type: 'TEXT', notNull: false, primaryKeyOrder: 0 },
    { name: 'status', type: 'TEXT', notNull: true, primaryKeyOrder: 0 },
    { name: 'created_at', type: 'TEXT', notNull: true, primaryKeyOrder: 0 }
  ]);
  assert.deepEqual(payload.rows[0], {
    id: 1,
    display_name: '小橘',
    age: '3',
    status: 'new',
    created_at: payload.rows[0].created_at
  });
  assert.match(payload.rows[0].created_at, /^\d{4}-\d{2}-\d{2} /);
});

test('可使用旧主键定位并修改主键值', async (context) => {
  const service = await startTestServer();
  context.after(() => service.close());

  const registered = await registerDatabase(service, {
    name: '测试库',
    path: service.databasePath
  });
  const database = (await registered.json()).database;

  await service.request(`/api/databases/${database.id}/tables/users/rows`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ values: { name: '小橘', age: 3 } })
  });
  const updated = await service.request(`/api/databases/${database.id}/tables/users/rows`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: { id: 1 }, values: { id: 9, name: '主人', age: 4 } })
  });
  assert.equal(updated.status, 204);

  const data = await service.request(`/api/databases/${database.id}/tables/users`);
  assert.deepEqual((await data.json()).rows, [{ id: 9, name: '主人', age: 4 }]);
});

test('其他表引用主键时仍可编辑未引用字段', async (context) => {
  const service = await startTestServer();
  context.after(() => service.close());
  const databaseFile = new DatabaseSync(service.databasePath);
  databaseFile.exec('CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id))');
  databaseFile.close();

  const registered = await registerDatabase(service, {
    name: '测试库',
    path: service.databasePath
  });
  const database = (await registered.json()).database;

  const changed = await service.request(`/api/databases/${database.id}/tables/users/schema`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      columns: [
        { name: 'id', type: 'INTEGER', sourceName: 'id', primaryKey: true, notNull: false },
        { name: 'display_name', type: 'TEXT', sourceName: 'name', primaryKey: false, notNull: true },
        { name: 'age', type: 'TEXT', sourceName: 'age', primaryKey: false, notNull: false },
        { name: 'status', type: 'TEXT', sourceName: '', primaryKey: false, notNull: false }
      ]
    })
  });
  assert.equal(changed.status, 200);

  const related = new DatabaseSync(service.databasePath);
  assert.deepEqual(
    related.prepare('PRAGMA foreign_key_list(orders)').all().map((foreignKey) => ({ table: foreignKey.table, from: foreignKey.from, to: foreignKey.to })),
    [{ table: 'users', from: 'user_id', to: 'id' }]
  );
  related.close();

  await service.request(`/api/databases/${database.id}/tables/users/rows`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ values: { id: 1, display_name: '小橘', age: '3', status: 'new' } })
  });
  const primaryKeyUpdate = await service.request(`/api/databases/${database.id}/tables/users/rows`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: { id: 1 }, values: { id: 9 } })
  });
  assert.equal(primaryKeyUpdate.status, 400);
  assert.match((await primaryKeyUpdate.json()).error, /字段“id”被其他表的外键引用/);

  const rejected = await service.request(`/api/databases/${database.id}/tables/users/schema`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      columns: [
        { name: 'user_id', type: 'INTEGER', sourceName: 'id', primaryKey: true, notNull: false },
        { name: 'display_name', type: 'TEXT', sourceName: 'display_name', primaryKey: false, notNull: true },
        { name: 'age', type: 'TEXT', sourceName: 'age', primaryKey: false, notNull: false },
        { name: 'status', type: 'TEXT', sourceName: 'status', primaryKey: false, notNull: false }
      ]
    })
  });
  assert.equal(rejected.status, 400);
  assert.match((await rejected.json()).error, /字段“id”被其他表的外键引用/);
});
