import express from 'express';
import multer from 'multer';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const SQLITE_EXTENSIONS = new Set(['.db', '.sqlite', '.sqlite3', '.db3']);
const SQLITE_HEADER = 'SQLite format 3\u0000';

function quoteIdentifier(name) {
  return `"${String(name).replaceAll('"', '""')}"`;
}

function validateUploadedDatabase(file) {
  const extension = extname(file?.originalname || '').toLowerCase();
  if (!SQLITE_EXTENSIONS.has(extension)) {
    throw new Error('仅允许上传 .db、.db3、.sqlite 或 .sqlite3 文件。');
  }
  if (!Buffer.isBuffer(file?.buffer) || file.buffer.length < SQLITE_HEADER.length) {
    throw new Error('上传的数据库文件为空或格式不正确。');
  }
  if (file.buffer.subarray(0, SQLITE_HEADER.length).toString('utf8') !== SQLITE_HEADER) {
    throw new Error('上传文件不是有效的 SQLite 数据库。');
  }
  return extension;
}

function saveUploadedDatabase(uploadDirectory, file) {
  const extension = validateUploadedDatabase(file);
  const identifier = randomUUID();
  const temporaryPath = resolve(uploadDirectory, `${identifier}.upload`);
  const databasePath = resolve(uploadDirectory, `${identifier}${extension}`);
  mkdirSync(uploadDirectory, { recursive: true });
  try {
    writeFileSync(temporaryPath, file.buffer);
    const database = new DatabaseSync(temporaryPath);
    try {
      database.prepare('PRAGMA schema_version').get();
    } finally {
      database.close();
    }
    renameSync(temporaryPath, databasePath);
    return databasePath;
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function parseAuthentication(authPath) {
  if (!existsSync(authPath)) {
    throw new Error('找不到认证配置文件 auth.json。');
  }
  try {
    const value = JSON.parse(readFileSync(authPath, 'utf8'));
    const username = typeof value.username === 'string' ? value.username.trim() : '';
    const password = typeof value.password === 'string' ? value.password : '';
    if (!username || !password || username === '请填写登录账号' || password === '请填写登录密码') {
      throw new Error('请先在 auth.json 中填写登录账号和密码。');
    }
    return { username, password };
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('auth.json 格式不正确。');
    }
    throw error;
  }
}

function parseCookies(request) {
  return Object.fromEntries(
    (request.get('cookie') || '')
      .split(';')
      .map((item) => item.trim().split('='))
      .filter(([name, value]) => name && value)
      .map(([name, value]) => [name, decodeURIComponent(value)]),
  );
}

function credentialsMatch(left, right) {
  const leftValue = Buffer.from(left);
  const rightValue = Buffer.from(right);
  return leftValue.length === rightValue.length && timingSafeEqual(leftValue, rightValue);
}

function parseStoredDatabases(registryPath) {
  if (!existsSync(registryPath)) {
    return [];
  }

  try {
    const value = JSON.parse(readFileSync(registryPath, 'utf8'));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function saveStoredDatabases(registryPath, databases) {
  mkdirSync(dirname(registryPath), { recursive: true });
  writeFileSync(registryPath, `${JSON.stringify(databases, null, 2)}\n`, 'utf8');
}

function validateDatabasePath(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('请输入 SQLite 数据库路径。');
  }

  const inputPath = value.trim();
  const extension = extname(inputPath).toLowerCase();
  if (!SQLITE_EXTENSIONS.has(extension)) {
    throw new Error('仅允许登记 .db、.db3、.sqlite 或 .sqlite3 文件。');
  }

  return inputPath;
}

function resolveDatabasePath(path) {
  return resolve(path);
}

function isManagedUploadedDatabase(item, uploadDirectory) {
  return (
    item.source === 'upload' &&
    dirname(resolveDatabasePath(item.path)) === uploadDirectory
  );
}

function databaseError(error) {
  return error instanceof Error ? error.message : '数据库操作失败。';
}

function openDatabase(item) {
  const databasePath = resolveDatabasePath(item.path);
  if (!existsSync(databasePath) || !statSync(databasePath).isFile()) {
    throw new Error('数据库文件已不存在或当前服务无权访问。');
  }

  return new DatabaseSync(databasePath);
}

function listTables(database) {
  return database.prepare(`
    SELECT name, sql
    FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name COLLATE NOCASE
  `).all();
}

function findTable(database, tableName) {
  const table = listTables(database).find((item) => item.name === tableName);
  if (!table) {
    throw new Error('找不到指定的数据表。');
  }
  return table;
}

function getTableMetadata(database, tableName) {
  findTable(database, tableName);
  const columns = database.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all();
  if (columns.length === 0) {
    throw new Error('无法读取数据表结构。');
  }
  return columns.map((column) => ({
    name: column.name,
    type: column.type || 'TEXT',
    notNull: Boolean(column.notnull),
    defaultValue: column.dflt_value,
    primaryKeyOrder: column.pk
  }));
}

function getPrimaryKeyColumns(columns) {
  return columns
    .filter((column) => column.primaryKeyOrder > 0)
    .sort((left, right) => left.primaryKeyOrder - right.primaryKeyOrder)
    .map((column) => column.name);
}

function validateValues(values, columns, { requireAll = false } = {}) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new Error('提交的数据格式不正确。');
  }

  const knownColumns = new Set(columns.map((column) => column.name));
  const unknownColumns = Object.keys(values).filter((name) => !knownColumns.has(name));
  if (unknownColumns.length > 0) {
    throw new Error('提交了不存在的字段。');
  }

  const entries = Object.entries(values).filter(([, value]) => value !== undefined);
  if (requireAll && entries.length === 0) {
    throw new Error('请至少填写一个字段。');
  }
  if (entries.length === 0) {
    throw new Error('没有可保存的字段。');
  }

  return entries;
}

function buildWhereClause(key, primaryKeys) {
  if (!key || typeof key !== 'object' || Array.isArray(key)) {
    throw new Error('缺少主键定位信息。');
  }
  if (primaryKeys.length === 0) {
    throw new Error('该表没有主键，不能安全地编辑或删除记录。');
  }

  const missing = primaryKeys.filter((name) => !Object.hasOwn(key, name));
  const extras = Object.keys(key).filter((name) => !primaryKeys.includes(name));
  if (missing.length > 0 || extras.length > 0) {
    throw new Error('主键定位信息不完整。');
  }

  return {
    sql: primaryKeys.map((name) => `${quoteIdentifier(name)} IS ?`).join(' AND '),
    values: primaryKeys.map((name) => key[name])
  };
}

const COLUMN_TYPES = new Set(['INTEGER', 'REAL', 'TEXT', 'BLOB', 'NUMERIC']);
const DEFAULT_VALUE_PATTERN = /^(NULL|CURRENT_TIME|CURRENT_DATE|CURRENT_TIMESTAMP|[-+]?\d+(?:\.\d+)?|'(?:''|[^'])*'|"(?:""|[^"])*"|(?:date|datetime|time|strftime)\([^;]*\))$/i;

function validateDefaultValue(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const defaultValue = value.trim();
  if (!DEFAULT_VALUE_PATTERN.test(defaultValue)) {
    throw new Error('默认值仅支持 NULL、数字、字符串、当前时间或日期时间函数。');
  }
  return defaultValue;
}

function validateSchemaColumns(columns, existingColumns) {
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new Error('请至少保留一个字段。');
  }

  const existingNames = new Set(existingColumns.map((column) => column.name));
  const usedSourceNames = new Set();
  const nextColumns = columns.map((column) => {
    const name = typeof column?.name === 'string' ? column.name.trim() : '';
    const type = typeof column?.type === 'string' ? column.type.trim().toUpperCase() : '';
    const sourceName = typeof column?.sourceName === 'string' ? column.sourceName : '';
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !COLUMN_TYPES.has(type)) {
      throw new Error('字段名称或类型不合法。');
    }
    if (sourceName && !existingNames.has(sourceName)) {
      throw new Error('字段来源不合法。');
    }
    if (sourceName && usedSourceNames.has(sourceName)) {
      throw new Error('同一个原字段只能保留一次。');
    }
    if (sourceName) usedSourceNames.add(sourceName);
    return {
      name,
      type,
      sourceName,
      primaryKey: Boolean(column?.primaryKey),
      notNull: Boolean(column?.notNull),
      defaultValue: validateDefaultValue(column?.defaultValue)
    };
  });

  if (new Set(nextColumns.map((column) => column.name)).size !== nextColumns.length) {
    throw new Error('字段名不能重复。');
  }
  if (nextColumns.every((column) => !column.sourceName)) {
    throw new Error('至少需要保留一个原字段，才能安全迁移已有数据。');
  }
  if (nextColumns.some((column) => !column.sourceName && column.notNull && column.defaultValue === null)) {
    throw new Error('新增非空字段必须设置默认值。');
  }

  return nextColumns;
}

function getInboundReferencedColumns(database, table, existingColumns) {
  const primaryKeyNames = existingColumns
    .filter((column) => column.primaryKeyOrder > 0)
    .sort((left, right) => left.primaryKeyOrder - right.primaryKeyOrder)
    .map((column) => column.name);
  const referencedColumns = new Set();
  for (const otherTable of listTables(database)) {
    if (otherTable.name === table.name) continue;
    const foreignKeys = database.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(otherTable.name)})`).all();
    for (const foreignKey of foreignKeys) {
      if (String(foreignKey.table).toLowerCase() !== table.name.toLowerCase()) continue;
      const referencedName = foreignKey.to || primaryKeyNames[foreignKey.seq] || primaryKeyNames[0];
      if (referencedName) referencedColumns.add(referencedName);
    }
  }
  return referencedColumns;
}

function ensureSchemaCanBeRebuilt(database, table, columns, existingColumns) {
  if (/^CREATE\s+VIRTUAL\s+TABLE/i.test(table.sql || '')) {
    throw new Error('虚拟表暂不支持编辑表设计。');
  }
  if (/\b(?:UNIQUE|CHECK|FOREIGN\s+KEY|COLLATE|GENERATED)\b/i.test(table.sql || '')) {
    throw new Error('含有唯一、检查、外键、排序规则或生成列的表暂不支持编辑，请使用 SQL 工具处理。');
  }

  const referencedColumns = getInboundReferencedColumns(database, table, existingColumns);
  for (const referencedName of referencedColumns) {
    const existingColumn = existingColumns.find((column) => column.name === referencedName);
    const nextColumn = columns.find((column) => column.sourceName === referencedName);
    if (
      !existingColumn ||
      !nextColumn ||
      nextColumn.name !== existingColumn.name ||
      nextColumn.type !== existingColumn.type ||
      !nextColumn.primaryKey
    ) {
      throw new Error(`字段“${referencedName}”被其他表的外键引用，不能删除、重命名、修改类型或取消主键。`);
    }
  }
}

function ensureReferencedPrimaryKeysAreUnchanged(database, table, columns, key, values) {
  const referencedColumns = getInboundReferencedColumns(database, table, columns);
  for (const name of referencedColumns) {
    if (!Object.hasOwn(values, name)) continue;
    if (String(values[name] ?? '') !== String(key[name] ?? '')) {
      throw new Error(`字段“${name}”被其他表的外键引用，不能修改其值。`);
    }
  }
}

function replaceTableSchema(database, table, columns, existingColumns) {
  ensureSchemaCanBeRebuilt(database, table, columns, existingColumns);
  const temporaryName = `__schema_edit_${randomUUID().replaceAll('-', '')}`;
  const schemaEntries = database.prepare(`
    SELECT type, sql
    FROM sqlite_master
    WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL
  `).all(table.name);
  const primaryKeys = columns.filter((column) => column.primaryKey);
  const definitions = columns.map((column) => {
    const primaryKey = primaryKeys.length === 1 && column.primaryKey ? ' PRIMARY KEY' : '';
    const notNull = column.notNull ? ' NOT NULL' : '';
    const defaultValue =
      column.defaultValue === null
        ? ''
        : /^(?:date|datetime|time|strftime)\(/i.test(column.defaultValue)
          ? ` DEFAULT (${column.defaultValue})`
          : ` DEFAULT ${column.defaultValue}`;
    return `${quoteIdentifier(column.name)} ${column.type}${primaryKey}${notNull}${defaultValue}`;
  });
  if (primaryKeys.length > 1) {
    definitions.push(`PRIMARY KEY (${primaryKeys.map((column) => quoteIdentifier(column.name)).join(', ')})`);
  }
  const retainedColumns = columns.filter((column) => column.sourceName);
  const targetColumns = retainedColumns.map((column) => quoteIdentifier(column.name)).join(', ');
  const sourceColumns = retainedColumns.map((column) => quoteIdentifier(column.sourceName)).join(', ');

  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(`CREATE TABLE ${quoteIdentifier(temporaryName)} (${definitions.join(', ')})`);
    database.exec(`INSERT INTO ${quoteIdentifier(temporaryName)} (${targetColumns}) SELECT ${sourceColumns} FROM ${quoteIdentifier(table.name)}`);
    database.exec(`DROP TABLE ${quoteIdentifier(table.name)}`);
    database.exec(`ALTER TABLE ${quoteIdentifier(temporaryName)} RENAME TO ${quoteIdentifier(table.name)}`);
    for (const entry of schemaEntries) database.exec(entry.sql);
    database.exec('COMMIT');
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {}
    throw error;
  }
}

export function createApp({ registryPath, authPath = resolve('auth.json') }) {
  const app = express();
  const authentication = parseAuthentication(authPath);
  const sessions = new Map();
  const publicDirectory = resolve('public');
  const uploadDirectory = resolve(dirname(registryPath), 'uploads');
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024, files: 1 }
  });
  app.use(express.json({ limit: '1mb' }));

  function sessionFor(request) {
    const sessionId = parseCookies(request).sqliteSession;
    const expiresAt = sessions.get(sessionId);
    if (!expiresAt || expiresAt < Date.now()) {
      sessions.delete(sessionId);
      return null;
    }
    return sessionId;
  }

  function requireAuthentication(request, response, next) {
    if (sessionFor(request)) return next();
    if (request.path.startsWith('/api/')) {
      return response.status(401).json({ error: '请先登录。' });
    }
    return response.redirect('/login');
  }

  app.get('/login', (request, response) => {
    if (sessionFor(request)) return response.redirect('/');
    return response.sendFile(resolve(publicDirectory, 'login.html'));
  });
  app.get('/styles.css', (request, response) => response.sendFile(resolve(publicDirectory, 'styles.css')));
  app.get('/login.js', (request, response) => response.sendFile(resolve(publicDirectory, 'login.js')));
  app.post('/api/auth/login', (request, response) => {
    const username = typeof request.body?.username === 'string' ? request.body.username : '';
    const password = typeof request.body?.password === 'string' ? request.body.password : '';
    if (!credentialsMatch(username, authentication.username) || !credentialsMatch(password, authentication.password)) {
      return response.status(401).json({ error: '账号或密码错误。' });
    }
    const sessionId = randomBytes(32).toString('hex');
    sessions.set(sessionId, Date.now() + 8 * 60 * 60 * 1000);
    response.cookie('sqliteSession', sessionId, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 8 * 60 * 60 * 1000,
      path: '/'
    });
    return response.status(204).end();
  });
  app.post('/api/auth/logout', (request, response) => {
    const sessionId = parseCookies(request).sqliteSession;
    sessions.delete(sessionId);
    response.clearCookie('sqliteSession', { path: '/' });
    return response.status(204).end();
  });
  app.use(requireAuthentication);
  app.use(express.static(publicDirectory));

  function getRegisteredDatabase(id) {
    const item = parseStoredDatabases(registryPath).find((database) => database.id === id);
    if (!item) {
      throw new Error('找不到已登记的数据库。');
    }
    return item;
  }

  function withDatabase(id, handler) {
    const database = openDatabase(getRegisteredDatabase(id));
    try {
      return handler(database);
    } finally {
      database.close();
    }
  }

  app.get('/api/databases', (request, response) => {
    const databases = parseStoredDatabases(registryPath).map((database) => {
      const path = resolveDatabasePath(database.path);
      return {
        ...database,
        available: existsSync(path) && statSync(path).isFile()
      };
    });
    response.json({ databases });
  });

  app.post('/api/databases', upload.single('databaseFile'), (request, response, next) => {
    let uploadedPath = null;
    try {
      const source = request.body?.source;
      const name = typeof request.body?.name === 'string' ? request.body.name.trim() : '';
      if (!name) {
        throw new Error('请输入显示名称。');
      }
      if (!['path', 'upload'].includes(source)) {
        throw new Error('请选择数据库来源。');
      }
      if (source === 'path' && request.file) {
        throw new Error('填写路径时不能同时上传文件。');
      }
      if (source === 'upload' && !request.file) {
        throw new Error('请选择要上传的 SQLite 文件。');
      }

      const path = source === 'upload'
        ? (uploadedPath = saveUploadedDatabase(uploadDirectory, request.file))
        : validateDatabasePath(request.body?.path);
      const databases = parseStoredDatabases(registryPath);
      if (databases.some((database) => database.path.toLowerCase() === path.toLowerCase())) {
        throw new Error('此数据库已经登记。');
      }

      const item = {
        id: randomUUID(),
        name,
        path,
        source,
        createdAt: new Date().toISOString()
      };
      databases.push(item);
      saveStoredDatabases(registryPath, databases);
      response.status(201).json({ database: item });
    } catch (error) {
      if (uploadedPath) rmSync(uploadedPath, { force: true });
      next(error);
    }
  });

  app.delete('/api/databases/:databaseId', (request, response, next) => {
    try {
      const databases = parseStoredDatabases(registryPath);
      const database = databases.find((item) => item.id === request.params.databaseId);
      if (!database) {
        throw new Error('找不到已登记的数据库。');
      }
      if (isManagedUploadedDatabase(database, uploadDirectory)) {
        rmSync(resolveDatabasePath(database.path), { force: true });
      }
      saveStoredDatabases(
        registryPath,
        databases.filter((item) => item.id !== request.params.databaseId),
      );
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/databases/:databaseId/tables', (request, response, next) => {
    try {
      const tables = withDatabase(request.params.databaseId, (database) => listTables(database).map((table) => ({ name: table.name })));
      response.json({ tables });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/databases/:databaseId/tables', (request, response, next) => {
    try {
      const tableName = typeof request.body?.name === 'string' ? request.body.name.trim() : '';
      const columns = Array.isArray(request.body?.columns) ? request.body.columns : [];
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) {
        throw new Error('表名只能包含字母、数字和下划线，且不能以数字开头。');
      }
      if (columns.length === 0) {
        throw new Error('请至少添加一个字段。');
      }
      const definitions = columns.map((column) => {
        const name = typeof column?.name === 'string' ? column.name.trim() : '';
        const type = typeof column?.type === 'string' ? column.type.trim().toUpperCase() : '';
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !['INTEGER', 'REAL', 'TEXT', 'BLOB', 'NUMERIC'].includes(type)) {
          throw new Error('字段名称或类型不合法。');
        }
        return `${quoteIdentifier(name)} ${type}${column.primaryKey ? ' PRIMARY KEY' : ''}${column.notNull ? ' NOT NULL' : ''}`;
      });
      if (new Set(columns.map((column) => column.name.trim())).size !== columns.length) {
        throw new Error('字段名不能重复。');
      }
      withDatabase(request.params.databaseId, (database) => {
        database.exec(`CREATE TABLE ${quoteIdentifier(tableName)} (${definitions.join(', ')})`);
      });
      response.status(201).json({ table: { name: tableName } });
    } catch (error) {
      next(error);
    }
  });

  app.put('/api/databases/:databaseId/tables/:tableName/schema', (request, response, next) => {
    try {
      const columns = withDatabase(request.params.databaseId, (database) => {
        const table = findTable(database, request.params.tableName);
        const existingColumns = getTableMetadata(database, request.params.tableName);
        const nextColumns = validateSchemaColumns(request.body?.columns, existingColumns);
        replaceTableSchema(database, table, nextColumns, existingColumns);
        return getTableMetadata(database, request.params.tableName);
      });
      response.json({ columns });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/databases/:databaseId/tables/:tableName', (request, response, next) => {
    try {
      const page = Math.max(1, Number.parseInt(request.query.page, 10) || 1);
      const pageSize = Math.min(100, Math.max(1, Number.parseInt(request.query.pageSize, 10) || 25));
      const search = typeof request.query.search === 'string' ? request.query.search.trim() : '';
      const payload = withDatabase(request.params.databaseId, (database) => {
        const columns = getTableMetadata(database, request.params.tableName);
        const primaryKeys = getPrimaryKeyColumns(columns);
        const searchableColumns = columns.filter((column) => column.type.toUpperCase() !== 'BLOB');
        const where = search && searchableColumns.length > 0
          ? ` WHERE ${searchableColumns.map((column) => `CAST(${quoteIdentifier(column.name)} AS TEXT) LIKE ?`).join(' OR ')}`
          : '';
        const parameters = search ? searchableColumns.map(() => `%${search}%`) : [];
        const total = database.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(request.params.tableName)}${where}`).get(...parameters).count;
        const rows = database.prepare(`SELECT * FROM ${quoteIdentifier(request.params.tableName)}${where} LIMIT ? OFFSET ?`).all(...parameters, pageSize, (page - 1) * pageSize);
        return { columns, primaryKeys, rows, page, pageSize, total };
      });
      response.json(payload);
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/databases/:databaseId/tables/:tableName/rows', (request, response, next) => {
    try {
      const row = withDatabase(request.params.databaseId, (database) => {
        const columns = getTableMetadata(database, request.params.tableName);
        const entries = validateValues(request.body?.values, columns, { requireAll: true });
        const names = entries.map(([name]) => quoteIdentifier(name)).join(', ');
        const placeholders = entries.map(() => '?').join(', ');
        const result = database.prepare(`INSERT INTO ${quoteIdentifier(request.params.tableName)} (${names}) VALUES (${placeholders})`).run(...entries.map(([, value]) => value));
        return { changes: result.changes, lastInsertRowid: String(result.lastInsertRowid) };
      });
      response.status(201).json({ row });
    } catch (error) {
      next(error);
    }
  });

  app.put('/api/databases/:databaseId/tables/:tableName/rows', (request, response, next) => {
    try {
      withDatabase(request.params.databaseId, (database) => {
        const table = findTable(database, request.params.tableName);
        const columns = getTableMetadata(database, request.params.tableName);
        const primaryKeys = getPrimaryKeyColumns(columns);
        const entries = validateValues(request.body?.values, columns);
        const values = Object.fromEntries(entries);
        const where = buildWhereClause(request.body?.key, primaryKeys);
        ensureReferencedPrimaryKeysAreUnchanged(
          database,
          table,
          columns,
          request.body?.key,
          values,
        );
        const setClause = entries.map(([name]) => `${quoteIdentifier(name)} = ?`).join(', ');
        const result = database.prepare(`UPDATE ${quoteIdentifier(request.params.tableName)} SET ${setClause} WHERE ${where.sql}`).run(...entries.map(([, value]) => value), ...where.values);
        if (result.changes !== 1) {
          throw new Error('未找到要更新的记录。');
        }
      });
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/databases/:databaseId/tables/:tableName/rows', (request, response, next) => {
    try {
      withDatabase(request.params.databaseId, (database) => {
        const columns = getTableMetadata(database, request.params.tableName);
        const where = buildWhereClause(request.body?.key, getPrimaryKeyColumns(columns));
        const result = database.prepare(`DELETE FROM ${quoteIdentifier(request.params.tableName)} WHERE ${where.sql}`).run(...where.values);
        if (result.changes !== 1) {
          throw new Error('未找到要删除的记录。');
        }
      });
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.use((error, request, response, next) => {
    response.status(400).json({ error: databaseError(error) });
  });

  return app;
}
