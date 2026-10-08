const state = {
  databases: [],
  database: null,
  tables: [],
  table: null,
  tableData: null,
  search: "",
  page: 1,
  rowMode: "create",
  editingRow: null,
};

const elements = {
  databaseList: document.querySelector("#database-list"),
  welcomeView: document.querySelector("#welcome-view"),
  databaseView: document.querySelector("#database-view"),
  databaseTitle: document.querySelector("#database-title"),
  databasePath: document.querySelector("#database-path"),
  tableList: document.querySelector("#table-list"),
  tableCount: document.querySelector("#table-count"),
  tableView: document.querySelector("#table-view"),
  message: document.querySelector("#message"),
  databaseDialog: document.querySelector("#database-dialog"),
  databaseUploadInput: document.querySelector("#database-upload-input"),
  databasePathField: document.querySelector("#database-path-field"),
  databasePathInput: document.querySelector("#database-path-input"),
  databaseUploadField: document.querySelector("#database-upload-field"),
  tableDialog: document.querySelector("#table-dialog"),
  rowDialog: document.querySelector("#row-dialog"),
  rowFields: document.querySelector("#row-fields"),
  rowForm: document.querySelector("#row-form"),
  schemaDialog: document.querySelector("#schema-dialog"),
  schemaForm: document.querySelector("#schema-form"),
  schemaTitle: document.querySelector("#schema-dialog-title"),
  schemaColumns: document.querySelector("#schema-columns"),
  columnEditor: document.querySelector("#column-editor"),
};

async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json", ...options.headers },
    ...options,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    if (response.status === 401) window.location.assign("/login");
    throw new Error(body.error || "请求失败，请稍后重试。");
  }
  return response.status === 204 ? null : response.json();
}

function showMessage(message, success = false) {
  elements.message.textContent = message;
  elements.message.className = success ? "message success" : "message";
  if (message)
    window.setTimeout(() => {
      if (elements.message.textContent === message) showMessage("");
    }, 4500);
}

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>'"]/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[
      character
      ],
  );
}

function toInputValue(value) {
  return value === null || value === undefined ? "" : String(value);
}

function primaryKey(row) {
  return Object.fromEntries(
    state.tableData.primaryKeys.map((name) => [name, row[name]]),
  );
}

function renderDatabases() {
  elements.databaseList.innerHTML =
    state.databases.length === 0
      ? '<div class="no-rows">尚未登记数据库</div>'
      : state.databases
        .map(
          (database) =>
            `<button class="database-item ${database.id === state.database?.id ? "active" : ""} ${database.available ? "" : "unavailable"}" data-database-id="${database.id}" type="button"><strong>${escapeHtml(database.name)}</strong><small>${escapeHtml(database.path)}</small></button>`,
        )
        .join("");
  elements.welcomeView.classList.toggle("hidden", Boolean(state.database));
  elements.databaseView.classList.toggle("hidden", !state.database);
  if (state.database) {
    elements.databaseTitle.textContent = state.database.name;
    elements.databasePath.textContent = state.database.path;
  }
}

function renderTables() {
  elements.tableCount.textContent = state.tables.length;
  elements.tableList.innerHTML =
    state.tables.length === 0
      ? '<div class="no-rows">此数据库没有数据表</div>'
      : state.tables
        .map(
          (table) =>
            `<button class="table-item ${table.name === state.table ? "active" : ""}" data-table-name="${escapeHtml(table.name)}" type="button">${escapeHtml(table.name)}</button>`,
        )
        .join("");
}

function renderTable() {
  const data = state.tableData;
  if (!state.table || !data) {
    elements.tableView.innerHTML =
      '<div class="empty-table">从左侧选择一个数据表喵</div>';
    return;
  }
  const hasPrimaryKey = data.primaryKeys.length > 0;
  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const headers = data.columns
    .map(
      (column) =>
        `<th title="${escapeHtml(column.type)}">${escapeHtml(column.name)}</th>`,
    )
    .join("");
  const rows = data.rows
    .map(
      (row, index) =>
        `<tr>${data.columns.map((column) => `<td title="${escapeHtml(toInputValue(row[column.name]))}">${escapeHtml(toInputValue(row[column.name]))}</td>`).join("")}<td><div class="row-actions">${hasPrimaryKey ? `<button class="row-action" data-edit-row="${index}" type="button">编辑</button><button class="row-action delete" data-delete-row="${index}" type="button">删除</button>` : '<span title="此表没有主键，无法安全编辑">只读</span>'}</div></td></tr>`,
    )
    .join("");
  elements.tableView.innerHTML = `<div class="table-header"><div><span class="eyebrow">${data.total} 条记录</span><h2>${escapeHtml(state.table)}</h2></div><div class="table-actions"><button id="view-schema-button" class="button button-secondary" type="button">编辑表设计</button><input id="search-input" class="search-input" value="${escapeHtml(state.search)}" placeholder="搜索当前数据表" /><button id="add-row-button" class="button button-primary" type="button" ${hasPrimaryKey ? "" : 'disabled title="没有主键的数据表不能安全编辑"'}>新增记录</button></div></div><div class="table-scroll">${data.rows.length ? `<table class="data-table"><thead><tr>${headers}<th>操作</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="no-rows">没有匹配的记录</div>'}</div><div class="pagination"><button id="previous-page" class="button button-secondary" type="button" ${data.page <= 1 ? "disabled" : ""}>上一页</button><span>第 ${data.page} / ${totalPages} 页</span><button id="next-page" class="button button-secondary" type="button" ${data.page >= totalPages ? "disabled" : ""}>下一页</button></div>`;
}

async function loadDatabases() {
  const data = await request("/api/databases");
  state.databases = data.databases;
  if (state.database)
    state.database =
      state.databases.find((item) => item.id === state.database.id) || null;
  renderDatabases();
}

async function selectDatabase(id) {
  const database = state.databases.find((item) => item.id === id);
  if (!database) return;
  state.database = database;
  state.tables = [];
  state.table = null;
  state.tableData = null;
  renderDatabases();
  renderTables();
  renderTable();
  try {
    const data = await request(`/api/databases/${id}/tables`);
    state.tables = data.tables;
    renderTables();
    if (data.tables.length > 0) await selectTable(data.tables[0].name);
  } catch (error) {
    showMessage(error.message);
  }
}

async function selectTable(name) {
  state.table = name;
  state.search = "";
  state.page = 1;
  renderTables();
  await loadTableData();
}

async function loadTableData() {
  if (!state.database || !state.table) return;
  try {
    const parameters = new URLSearchParams({ page: state.page, pageSize: 25 });
    if (state.search) parameters.set("search", state.search);
    state.tableData = await request(
      `/api/databases/${state.database.id}/tables/${encodeURIComponent(state.table)}?${parameters}`,
    );
    renderTable();
  } catch (error) {
    showMessage(error.message);
  }
}

function openRowDialog(mode, row = null) {
  const data = state.tableData;
  if (!data) return;
  state.rowMode = mode;
  state.editingRow = row;
  document.querySelector("#row-dialog-title").textContent =
    mode === "create" ? "新增记录" : "编辑记录";
  document.querySelector("#row-dialog-eyebrow").textContent = state.table;
  elements.rowFields.innerHTML = data.columns
    .map((column) => {
      const isKey = data.primaryKeys.includes(column.name);
      const value = row?.[column.name];
      const autoGeneratedKey =
        mode === "create" && isKey && column.type.toUpperCase().includes("INT");
      return `<label>${escapeHtml(column.name)} <span class="field-meta">${escapeHtml(column.type)}${column.notNull ? " · 必填" : ""}${mode === "edit" && isKey ? " · 主键可修改" : ""}</span><input name="${escapeHtml(column.name)}" value="${escapeHtml(toInputValue(value))}" ${mode === "edit" && isKey ? "required" : ""} ${autoGeneratedKey ? 'placeholder="自动生成（留空）"' : ""} /></label>`;
    })
    .join("");
  elements.rowDialog.showModal();
}

function addSchemaColumn({
  name = "",
  type = "TEXT",
  sourceName = "",
  primaryKey = false,
  notNull = false,
  defaultValue = "",
} = {}) {
  const row = document.createElement("tr");
  row.className = "schema-column-row";
  row.dataset.sourceName = sourceName;
  row.innerHTML = `<td><input name="schema-name" required pattern="[A-Za-z_][A-Za-z0-9_]*" value="${escapeHtml(name)}" aria-label="字段名" /></td><td><select name="schema-type" aria-label="字段类型"><option ${type === "TEXT" ? "selected" : ""}>TEXT</option><option ${type === "INTEGER" ? "selected" : ""}>INTEGER</option><option ${type === "REAL" ? "selected" : ""}>REAL</option><option ${type === "NUMERIC" ? "selected" : ""}>NUMERIC</option><option ${type === "BLOB" ? "selected" : ""}>BLOB</option></select></td><td><input name="schema-primary" type="checkbox" ${primaryKey ? "checked" : ""} aria-label="主键" /></td><td><input name="schema-not-null" type="checkbox" ${notNull ? "checked" : ""} aria-label="非空" /></td><td><input name="schema-default" value="${escapeHtml(toInputValue(defaultValue))}" placeholder="例如：'new'" aria-label="默认值" /></td><td><button class="icon-button remove-schema-column" type="button" aria-label="删除字段">×</button></td>`;
  elements.schemaColumns.append(row);
}

function openSchemaDialog() {
  const data = state.tableData;
  if (!data) return;
  elements.schemaTitle.textContent = `${state.table} · 编辑表设计`;
  elements.schemaColumns.innerHTML = "";
  data.columns.forEach((column) =>
    addSchemaColumn({
      name: column.name,
      type: column.type,
      sourceName: column.name,
      primaryKey: column.primaryKeyOrder > 0,
      notNull: column.notNull,
      defaultValue: column.defaultValue,
    }),
  );
  elements.schemaDialog.showModal();
}

function schemaColumns() {
  return [...elements.schemaColumns.querySelectorAll(".schema-column-row")].map(
    (row) => ({
      name: row.querySelector('[name="schema-name"]').value,
      type: row.querySelector('[name="schema-type"]').value,
      sourceName: row.dataset.sourceName,
      primaryKey: row.querySelector('[name="schema-primary"]').checked,
      notNull: row.querySelector('[name="schema-not-null"]').checked,
      defaultValue: row.querySelector('[name="schema-default"]').value,
    }),
  );
}

function addColumn({
  name = "",
  type = "TEXT",
  primaryKey = false,
  notNull = false,
} = {}) {
  const row = document.createElement("div");
  row.className = "column-row";
  row.innerHTML = `<input name="column-name" required pattern="[A-Za-z_][A-Za-z0-9_]*" value="${escapeHtml(name)}" placeholder="字段名" /><select name="column-type"><option ${type === "TEXT" ? "selected" : ""}>TEXT</option><option ${type === "INTEGER" ? "selected" : ""}>INTEGER</option><option ${type === "REAL" ? "selected" : ""}>REAL</option><option ${type === "NUMERIC" ? "selected" : ""}>NUMERIC</option><option ${type === "BLOB" ? "selected" : ""}>BLOB</option></select><label><input name="column-primary" type="checkbox" ${primaryKey ? "checked" : ""} /> 主键</label><label><input name="column-not-null" type="checkbox" ${notNull ? "checked" : ""} /> 非空</label><button class="icon-button remove-column" type="button" aria-label="移除字段">×</button>`;
  elements.columnEditor.append(row);
}

document.addEventListener("click", async (event) => {
  if (event.target.id === "logout-button") {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.assign("/login");
    return;
  }
  const databaseButton = event.target.closest("[data-database-id]");
  const tableButton = event.target.closest("[data-table-name]");
  const editButton = event.target.closest("[data-edit-row]");
  const deleteButton = event.target.closest("[data-delete-row]");
  if (
    event.target.matches('[data-open-dialog="database-dialog"]') ||
    event.target.id === "add-database-button"
  )
    elements.databaseDialog.showModal();
  if (event.target.matches("[data-close-dialog]"))
    event.target.closest("dialog").close();
  if (event.target.id === "refresh-databases-button") await loadDatabases();
  if (databaseButton) await selectDatabase(databaseButton.dataset.databaseId);
  if (tableButton) await selectTable(tableButton.dataset.tableName);
  if (event.target.id === "add-table-button") {
    elements.columnEditor.innerHTML = "";
    addColumn({ name: "id", type: "INTEGER", primaryKey: true });
    addColumn({ name: "name", type: "TEXT" });
    elements.tableDialog.showModal();
  }
  if (event.target.id === "add-column-button") addColumn();
  if (event.target.matches(".remove-column"))
    event.target.closest(".column-row").remove();
  if (event.target.id === "add-schema-column-button") addSchemaColumn();
  if (event.target.matches(".remove-schema-column"))
    event.target.closest(".schema-column-row").remove();
  if (event.target.id === "add-row-button") openRowDialog("create");
  if (event.target.id === "view-schema-button") openSchemaDialog();
  if (editButton)
    openRowDialog(
      "edit",
      state.tableData.rows[Number(editButton.dataset.editRow)],
    );
  if (deleteButton) {
    const row = state.tableData.rows[Number(deleteButton.dataset.deleteRow)];
    if (!window.confirm("确定删除这条记录吗？此操作无法撤销。")) return;
    try {
      await request(
        `/api/databases/${state.database.id}/tables/${encodeURIComponent(state.table)}/rows`,
        { method: "DELETE", body: JSON.stringify({ key: primaryKey(row) }) },
      );
      showMessage("记录已删除。", true);
      await loadTableData();
    } catch (error) {
      showMessage(error.message);
    }
  }
  if (event.target.id === "previous-page") {
    state.page--;
    await loadTableData();
  }
  if (event.target.id === "next-page") {
    state.page++;
    await loadTableData();
  }
  if (
    event.target.id === "remove-database-button" &&
    state.database &&
    window.confirm(
      state.database.source === "upload"
        ? `确定取消登记“${state.database.name}”吗？已上传的数据库文件也会被删除。`
        : `确定取消登记“${state.database.name}”吗？不会删除服务器上的原数据库文件。`,
    )
  ) {
    const uploadedDatabase = state.database.source === "upload";
    try {
      await request(`/api/databases/${state.database.id}`, {
        method: "DELETE",
      });
      state.database = null;
      state.tables = [];
      state.table = null;
      state.tableData = null;
      await loadDatabases();
      renderTables();
      renderTable();
      showMessage(
        uploadedDatabase
          ? "已取消登记，上传的数据库文件已删除。"
          : "已取消登记，原数据库文件未受影响。",
        true,
      );
    } catch (error) {
      showMessage(error.message);
    }
  }
});

document.addEventListener("input", (event) => {
  if (event.target.id === "search-input") {
    window.clearTimeout(event.target.searchTimer);
    event.target.searchTimer = window.setTimeout(async () => {
      state.search = event.target.value;
      state.page = 1;
      await loadTableData();
    }, 300);
  }
});

function setDatabaseSource(source) {
  const uploading = source === "upload";
  elements.databasePathField.classList.toggle("hidden", uploading);
  elements.databasePathInput.disabled = uploading;
  elements.databasePathInput.required = !uploading;
  elements.databaseUploadField.classList.toggle("hidden", !uploading);
  elements.databaseUploadInput.disabled = !uploading;
  elements.databaseUploadInput.required = uploading;
}

document.addEventListener("change", (event) => {
  if (event.target.name === "source") setDatabaseSource(event.target.value);
});

document
  .querySelector("#database-form")
  .addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      const response = await fetch("/api/databases", {
        method: "POST",
        body: new FormData(form),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "请求失败，请稍后重试。");
      }
      const data = await response.json();
      form.reset();
      setDatabaseSource("path");
      elements.databaseDialog.close();
      await loadDatabases();
      await selectDatabase(data.database.id);
      showMessage("数据库已登记。", true);
    } catch (error) {
      showMessage(error.message);
    }
  });

document
  .querySelector("#table-form")
  .addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const columns = [
      ...elements.columnEditor.querySelectorAll(".column-row"),
    ].map((row) => ({
      name: row.querySelector('[name="column-name"]').value,
      type: row.querySelector('[name="column-type"]').value,
      primaryKey: row.querySelector('[name="column-primary"]').checked,
      notNull: row.querySelector('[name="column-not-null"]').checked,
    }));
    try {
      const data = await request(`/api/databases/${state.database.id}/tables`, {
        method: "POST",
        body: JSON.stringify({
          name: new FormData(form).get("name"),
          columns,
        }),
      });
      form.reset();
      elements.tableDialog.close();
      const tables = await request(
        `/api/databases/${state.database.id}/tables`,
      );
      state.tables = tables.tables;
      await selectTable(data.table.name);
      showMessage("数据表已创建。", true);
    } catch (error) {
      showMessage(error.message);
    }
  });

elements.schemaForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const columns = schemaColumns();
  if (
    !window.confirm(
      "保存将重建数据表并迁移保留字段的数据。请确认已备份数据库，是否继续？",
    )
  )
    return;
  try {
    await request(
      `/api/databases/${state.database.id}/tables/${encodeURIComponent(state.table)}/schema`,
      { method: "PUT", body: JSON.stringify({ columns }) },
    );
    elements.schemaDialog.close();
    await loadTableData();
    showMessage("表设计已保存。", true);
  } catch (error) {
    showMessage(error.message);
  }
});

elements.rowForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const values = Object.fromEntries(
    [...form.entries()].filter(([, value]) => value !== ""),
  );
  try {
    const path = `/api/databases/${state.database.id}/tables/${encodeURIComponent(state.table)}/rows`;
    const primaryKeyChanged =
      state.rowMode === "edit" &&
      state.tableData.primaryKeys.some(
        (name) => values[name] !== String(state.editingRow[name] ?? ""),
      );
    if (
      primaryKeyChanged &&
      !window.confirm(
        "修改主键可能影响关联数据。若该主键被其他表外键引用，系统会拒绝保存。是否继续？",
      )
    )
      return;
    const body =
      state.rowMode === "create"
        ? { values }
        : {
          key: primaryKey(state.editingRow),
          values,
        };
    await request(path, {
      method: state.rowMode === "create" ? "POST" : "PUT",
      body: JSON.stringify(body),
    });
    elements.rowDialog.close();
    showMessage(
      state.rowMode === "create" ? "记录已新增。" : "记录已更新。",
      true,
    );
    await loadTableData();
  } catch (error) {
    showMessage(error.message);
  }
});

loadDatabases().catch((error) => showMessage(error.message));
