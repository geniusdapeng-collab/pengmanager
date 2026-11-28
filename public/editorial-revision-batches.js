import { escapeHtml as html } from "./publication-view.js";

const endpoint = "/api/editorial/revision-batches";
const status = {
  preparing: "准备母稿", ready: "待人工确认", queued: "已授权排队", publishing: "审核、激活或回读中",
  awaiting_review: "等待审核回执", rolled_back: "已恢复前版", published: "公网回读已完成", blocked: "需要处理", failed: "执行未完成",
};
const stages = { preflight: "导入预检", edition: "准备母稿", authorization: "核对后授权", approval: "正式审核", activation: "备份和激活", readback: "公网回读", rollback: "恢复前一版本" };
const kinds = { architecture: "架构图", logic: "逻辑图", scene: "场景图" };
const pageSize = 15;
const running = new Set(["preparing", "queued", "publishing", "awaiting_review"]);

function duration(milliseconds) {
  const seconds = Math.floor(milliseconds / 1000);
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function id(value) { return encodeURIComponent(value); }

function counts(values = {}) {
  return Object.entries(values).map(([key, value]) => `${status[key] || key} ${value}`).join(" · ");
}

function imageList(images, assets) {
  if (!images?.length) return "";
  return `<ol class="editorial-reference-list">${images.map(image => {
    const asset = assets.find(item => item.id === image.assetId);
    const rights = asset?.review?.rightsConfirmed === true && asset?.review?.privacyConfirmed === true ? "版权和隐私已审核" : "请核对素材审核记录";
    return `<li><strong>${html(kinds[image.kind] || image.kind)} · ${html(image.alt)}</strong>
      <p>${html(image.anchor)}${image.caption ? `<br />${html(image.caption)}` : ""}</p>
      <p>${html(rights)} · <a href="/api/media/assets/${id(image.assetId)}/bytes" target="_blank" rel="noopener">核对图片</a></p></li>`;
  }).join("")}</ol>`;
}

export function mountEditorialRevisionBatches(root, { api, mutate, getAssets, onRender }) {
  const state = {
    list: null, batch: null, preflight: null, manifest: null, file: null, error: null, busy: false,
    notice: "", selection: new Set(), note: "", filter: "", page: 0, comparisons: new Map(),
  };
  let active = false, timer, reading = false;

  function renderItem(item) {
    const pending = ["failed", "blocked", "awaiting_review"].includes(item.status);
    const checked = state.selection.has(item.id);
    const previous = state.comparisons.get(item.baseReleaseId);
    return `<article class="editorial-card">
      <header class="editorial-card-heading"><div><h4>${html(item.title)}</h4>
        <p><a href="${html(item.canonicalPath)}" target="_blank" rel="noopener">${html(item.canonicalPath)}</a></p>
      </div><span class="status-chip">${html(status[item.status] || item.status)}</span></header>
      ${item.stage ? `<p>${html(stages[item.stage] || item.stage)}${item.releaseId ? ` · ${html(item.releaseId)}` : ""}</p>` : ""}
      ${item.error ? `<p class="form-error">${html(item.error.message)} <code>${html(item.error.code)}</code></p>` : ""}
      ${item.elapsedMs ? `<p>累计 ${duration(item.elapsedMs)}
        ${Object.entries(item.stageDurationsMs ?? {}).map(([key, value]) => ` · ${html(stages[key] || key)} ${duration(value)}`).join("")}</p>` : ""}
      ${item.receipt ? `<p>回读时间 <time datetime="${html(item.receipt.verifiedAt)}">${html(item.receipt.verifiedAt)}</time> · ${item.receipt.assetHashes?.length ?? 0} 张图已校验</p>` : ""}
      <details class="editorial-exact" data-revision-details="${html(item.id)}"${previous ? " open" : ""}><summary>核对新旧正文和配图</summary>
        <div class="editorial-exact-content">
          ${previous?.error ? `<p class="form-error">${html(previous.error)}</p>` : ""}
          ${previous?.body !== undefined ? `<details class="editorial-exact"><summary>原发布 · ${html(previous.title)}</summary>
            <p>${html(previous.summary)}</p><pre class="editorial-body-source">${html(previous.body)}</pre></details>`
        : `<button class="ghost-button" type="button" data-revision-action="compare" data-revision-item="${html(item.id)}"${state.busy ? " disabled" : ""}>读取原发布正文</button>`}
          <h5>新稿</h5><p>${html(item.summary)}</p><pre class="editorial-body-source">${html(item.body)}</pre>
          ${imageList(item.illustrations?.length ? item.illustrations : previous?.images, getAssets())}
          ${item.editionSnapshotHash ? `<p class="editorial-hash">精确母稿 <code>${html(item.editionSnapshotHash)}</code></p>` : ""}
        </div>
      </details>
      ${item.status === "ready" ? `<label class="check-label"><input type="checkbox" value="${html(item.id)}" data-revision-selection${checked ? " checked" : ""}${state.busy ? " disabled" : ""} /><span>我已核对这篇稿件，加入本次发布授权</span></label>` : ""}
      ${pending ? `<div class="editorial-form">${item.error?.proofKey ? `<label>审核回执 JSON（已有正式回执时可填）<textarea rows="3" data-revision-proof="${html(item.id)}"${state.busy ? " disabled" : ""}></textarea></label>` : ""}
        <button class="ghost-button" type="button" data-revision-action="retry" data-revision-item="${html(item.id)}"${state.busy ? " disabled" : ""}>重新检查并续跑此篇</button></div>` : ""}
      ${item.releaseId && (item.status === "published" || pending && item.stage === "readback") ? `<details class="editorial-exact">
        <summary>恢复此篇的前一公开版本</summary>
        <form class="editorial-form" data-revision-form="rollback" data-revision-item="${html(item.id)}">
          <p>只有仍在使用本批次新版的原网址可以恢复。</p>
          <label>恢复原因<textarea name="reason" required maxlength="2000" rows="2"${state.busy ? " disabled" : ""}></textarea></label>
          <button class="ghost-button" type="submit"${state.busy ? " disabled" : ""}>确认恢复 ${html(item.baseReleaseId)}</button>
        </form>
      </details>` : ""}
    </article>`;
  }

  function markup() {
    const disabled = state.busy ? " disabled" : "";
    const list = state.list?.items || [];
    const batch = state.batch;
    const preflight = state.preflight;
    const items = batch?.items || [];
    const filtered = state.filter ? items.filter(item => item.status === state.filter) : items;
    const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
    const page = Math.min(state.page, pages - 1);
    return `<div class="editorial-stack" data-revision-panel aria-busy="${state.busy}">
      ${state.error ? `<p class="form-error" role="alert">${html(state.error)}</p>` : ""}
      ${state.notice ? `<p class="editorial-notice" role="status">${html(state.notice)}</p>` : ""}
      ${state.busy ? '<p role="status">正在处理本次请求…</p>' : ""}
      ${(batch?.workerError || state.list?.workerError) ? `<p class="form-error" role="alert">${html((batch?.workerError || state.list.workerError).message)}</p>` : ""}
      <section class="editorial-section">
        <h3>导入原址改稿</h3>
        <p>上传批次清单 JSON，填入原发布号、准确摘要和已审核素材编号。每批最多 100 篇。</p>
        <form class="editorial-form" data-revision-form="import">
          <label>改稿清单<input type="file" name="manifest" accept=".json,application/json"${disabled} /></label>
          ${state.file ? `<p>当前文件 ${html(state.file.name)}</p>` : ""}
          <button class="ghost-button" type="submit"${disabled}>检查清单</button>
        </form>
        ${preflight ? `<div class="editorial-stack"><h4>预检 · ${preflight.items.filter(item => !item.error).length} / ${preflight.items.length} 篇通过</h4>
          <ul>${preflight.items.map(item => `<li>${html(item.canonicalPath)} · ${html(item.error?.message || "可准备母稿")}</li>`).join("")}</ul>
          <button class="primary-button" type="button" data-revision-action="create"${disabled}>建立批次并准备母稿</button></div>` : ""}
      </section>
      <section class="editorial-section">
        <h3>已保存批次</h3>
        <label>打开批次<select data-revision-choose${disabled}><option value="">选择批次</option>
          ${list.map(row => `<option value="${html(row.id)}"${batch?.id === row.id ? " selected" : ""}>${html(row.id)} · ${html(counts(row.counts))}</option>`).join("")}
        </select></label>
        <button class="ghost-button" type="button" data-revision-action="refresh"${disabled}>刷新批次进度</button>
        <form class="editorial-form" data-revision-form="open">
          <label>按批次号打开<input type="text" name="batchId" required maxlength="80" pattern="ERB-[A-Fa-f0-9-]{36}"${disabled} /></label>
          <button class="ghost-button" type="submit"${disabled}>打开批次</button>
        </form>
        ${!state.list ? '<p role="status">正在读取已保存批次…</p>' : list.length ? "" : "<p>还没有已保存的批次。</p>"}
      </section>
      ${batch ? `<section class="editorial-section">
        <h3>批次进度</h3><p>${html(batch.id)} · ${html(counts(batch.counts))}</p>
        <div class="editorial-form">
          <label>按状态筛选<select data-revision-filter${disabled}><option value="">全部状态</option>
            ${Object.entries(status).map(([key, label]) => `<option value="${key}"${state.filter === key ? " selected" : ""}>${label}</option>`).join("")}
          </select></label>
          <button class="ghost-button" type="button" data-revision-action="report"${disabled}>下载进度与回执</button>
        </div>
        <p>${filtered.length} 篇</p>
        ${pages > 1 ? `<nav aria-label="批次文章分页">
          <button type="button" class="ghost-button" data-revision-action="page" data-revision-page="${page - 1}"${page === 0 || state.busy ? " disabled" : ""}>上一页</button>
          <span>第 ${page + 1} / ${pages} 页</span>
          <button type="button" class="ghost-button" data-revision-action="page" data-revision-page="${page + 1}"${page + 1 === pages || state.busy ? " disabled" : ""}>下一页</button></nav>` : ""}
        <div class="editorial-stack">${filtered.slice(page * pageSize, (page + 1) * pageSize).map(renderItem).join("") || "<p>当前筛选下没有文章。</p>"}</div>
        ${items.some(item => item.status === "ready") ? `<form class="editorial-form" data-revision-form="authorize">
          <label>公开授权说明<textarea name="authorizationNote" required minlength="8" maxlength="2000" rows="3"${disabled}>${html(state.note)}</textarea></label>
          <button type="submit" class="primary-button" data-revision-authorize${state.busy || !state.selection.size ? " disabled" : ""}>授权选中的 ${state.selection.size} 篇原址发布</button>
        </form>` : ""}
      </section>` : ""}
    </div>`;
  }

  function adopt(batch) {
    if (batch.id !== state.batch?.id) {
      state.selection.clear();
      state.comparisons.clear();
      state.note = "";
      state.filter = "";
      state.page = 0;
    }
    state.batch = batch;
    const ready = new Set(batch.items.filter(item => item.status === "ready").map(item => item.id));
    for (const item of state.selection) if (!ready.has(item)) state.selection.delete(item);
  }

  function schedule() {
    clearTimeout(timer);
    if (active && state.batch?.items.some(item => running.has(item.status))) {
      timer = setTimeout(() => void refresh(false), 5000);
    }
  }

  async function refresh(showError = true) {
    if (reading || state.busy || (!showError && document.activeElement?.closest("[data-revision-panel]") &&
        document.activeElement.matches("input, textarea, select"))) return schedule();
    const batch = state.batch;
    reading = true;
    try {
      const [list, current] = await Promise.all([
        showError || !state.list ? api(endpoint) : state.list,
        batch ? api(`${endpoint}/${id(batch.id)}`) : null,
      ]);
      if (!state.busy && state.batch === batch) {
        const changed = !state.list || current?.etag !== batch?.etag || showError;
        state.list = list;
        if (current) adopt(current);
        if (showError) state.error = null;
        if (active && changed) onRender();
      }
    } catch (error) {
      if (!state.busy && (showError || !state.error)) {
        state.error = error.message;
        if (!state.list) state.list = { items: [] };
        if (active) onRender();
      }
    } finally {
      reading = false;
      schedule();
    }
  }

  async function operate(action) {
    if (state.busy) return;
    state.busy = true;
    state.error = null;
    state.notice = "";
    onRender();
    try { await action(); }
    catch (error) { state.error = error.message; }
    finally {
      state.busy = false;
      if (active) onRender();
      schedule();
    }
  }

  root.addEventListener("change", event => {
    const target = event.target;
    if (!target.closest("[data-revision-panel]")) return;
    if (target.matches('[name="manifest"]')) {
      state.file = target.files?.[0] ?? null;
      state.preflight = null;
      state.manifest = null;
      onRender();
    } else if (target.matches("[data-revision-selection]")) {
      if (target.checked) state.selection.add(target.value);
      else state.selection.delete(target.value);
      const button = root.querySelector("[data-revision-authorize]");
      button.disabled = !state.selection.size;
      button.textContent = `授权选中的 ${state.selection.size} 篇原址发布`;
    } else if (target.matches("[data-revision-choose]") && target.value) {
      void operate(async () => adopt(await api(`${endpoint}/${id(target.value)}`)));
    } else if (target.matches("[data-revision-filter]")) {
      state.filter = target.value;
      state.page = 0;
      onRender();
    }
  });

  root.addEventListener("input", ({ target }) => {
    if (target.name === "authorizationNote" && target.closest('[data-revision-form="authorize"]')) state.note = target.value;
  });

  root.addEventListener("submit", event => {
    const form = event.target.closest("[data-revision-form]");
    if (!form) return;
    event.preventDefault();
    if (form.dataset.revisionForm === "import") {
      const file = state.file;
      void operate(async () => {
        if (!file) throw new Error("请选择批次清单。");
        if (file.size > 16_000_000) throw new Error("批次清单超过 16 MB，请拆小后重新导入。");
        let manifest;
        try { manifest = JSON.parse(await file.text()); }
        catch { throw new Error("此文件不是有效的清单 JSON。"); }
        const preflight = await api(`${endpoint}/preflight`, { method: "POST", body: JSON.stringify(manifest) });
        state.manifest = manifest;
        state.preflight = preflight;
      });
    } else if (form.dataset.revisionForm === "open") {
      const batchId = new FormData(form).get("batchId").trim();
      void operate(async () => adopt(await api(`${endpoint}/${id(batchId)}`)));
    } else if (form.dataset.revisionForm === "rollback") {
      const item = state.batch.items.find(row => row.id === form.dataset.revisionItem);
      const reason = new FormData(form).get("reason").trim();
      void operate(async () => {
        const path = `/api/website/releases/${id(item.releaseId)}`;
        const release = await api(path);
        await mutate(`${path}/rollback`, { expectedPreviousReleaseId: item.baseReleaseId, reason },
          { etag: release.etag, needsEtag: true });
        state.notice = `已恢复此篇的 ${item.baseReleaseId}，可从原网址核对。`;
        adopt(await api(`${endpoint}/${id(state.batch.id)}`));
      });
    } else {
      const batch = state.batch;
      const items = batch.items.filter(item => item.status === "ready" && state.selection.has(item.id))
        .map(({ id: itemId, editionSnapshotHash }) => ({ id: itemId, editionSnapshotHash }));
      void operate(async () => {
        adopt(await mutate(`${endpoint}/${id(batch.id)}/authorize`,
          { items, manifestHash: batch.manifestHash, authorizationNote: state.note },
          { etag: batch.etag, needsEtag: true }));
        state.note = "";
        state.notice = `${items.length} 篇已授权，服务端将继续处理。`;
      });
    }
  });

  root.addEventListener("click", event => {
    const button = event.target.closest("[data-revision-action]");
    if (!button) return;
    const batch = state.batch;
    const item = batch?.items.find(row => row.id === button.dataset.revisionItem);
    switch (button.dataset.revisionAction) {
      case "refresh": void refresh(); break;
      case "page":
        state.page = Number(button.dataset.revisionPage);
        onRender();
        break;
      case "report": {
        const report = { id: batch.id, manifestHash: batch.manifestHash, counts: batch.counts, updatedAt: batch.updatedAt,
          items: batch.items.map(({ id: itemId, canonicalPath, status: itemStatus, stage, releaseId, receipt, stageDurationsMs, error }) =>
            ({ id: itemId, canonicalPath, status: itemStatus, stage, releaseId, receipt, stageDurationsMs, error: error?.code ?? null })) };
        const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
        const link = document.createElement("a");
        link.href = url; link.download = `${batch.id}.json`; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        break;
      }
      case "create":
        void operate(async () => {
          adopt(await mutate(endpoint, state.manifest));
          state.notice = "批次已保存，可以稍后用批次号回来继续。";
          state.file = state.manifest = state.preflight = null;
          state.list = { items: [state.batch, ...(state.list?.items || []).filter(row => row.id !== state.batch.id)] };
        });
        break;
      case "compare":
        void operate(async () => {
          try {
            const slug = item.canonicalPath.split("/").at(-1);
            const previousUrl = item.expectedPublicSnapshotHash
              ? `/public-api/content/zh-CN/article/${id(slug)}` : `/api/website/releases/${id(item.baseReleaseId)}`;
            const planUrl = !item.illustrations?.length && item.illustrationPlanId
              ? `/api/stories/${id(item.storyId)}/illustrations/${id(item.illustrationPlanId)}` : null;
            const [previous, plan] = await Promise.all([api(previousUrl), planUrl ? api(planUrl) : null]);
            if (previous.snapshotHash !== (item.expectedPublicSnapshotHash || item.baseSnapshotHash)) {
              throw new Error("原发布内容摘要与批次记录不符。");
            }
            const images = plan?.slots.filter(slot => slot.evidence?.assetId).map(slot => ({ ...slot, assetId: slot.evidence.assetId }));
            state.comparisons.set(item.baseReleaseId, { ...(previous.publicSnapshot ?? previous), images });
          } catch (error) {
            state.comparisons.set(item.baseReleaseId, { error: error.message });
          }
        });
        break;
      case "retry": {
        const field = button.parentElement.querySelector("textarea");
        const proofText = field?.value.trim();
        void operate(async () => {
          let body = {};
          if (proofText) {
            let proof;
            try { proof = JSON.parse(proofText); }
            catch { throw new Error("审核回执需要有效的 JSON。"); }
            body = { reviewProofs: { [item.error.proofKey]: proof } };
          }
          adopt(await mutate(`${endpoint}/${id(batch.id)}/items/${id(item.id)}/retry`, body,
            { etag: batch.etag, needsEtag: true }));
          state.notice = "此篇已提交续跑。";
        });
        break;
      }
    }
  });

  return { markup, setActive(value) {
    if (active === value) return;
    active = value;
    if (active) void refresh();
    else clearTimeout(timer);
  } };
}
