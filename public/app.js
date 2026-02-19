const API_BASE = '/api';
const STORY_TYPES = ['news', 'feature', 'interview', 'opinion', 'review', 'recommendation', 'whats_on', 'history', 'other'];
const GENERATION_CONCURRENCY = 2;
const GENERATION_ETA_WINDOW = 5;

const app = {
    state: {
        currentStep: 1,
        directoryPath: '',
        articles: [],
        clusters: [],
        selectedStoryTypes: [...STORY_TYPES],
        clusterSort: 'date_desc',
        selectedClusterIds: new Set(),
        generatedArticles: {}, // clusterId -> article
        recentPosts: [],
        selectedSocialPostIds: new Set(),
        socialOutputDir: '',
        editorDrafts: {}, // clusterId -> editable article draft
        previewingClusterId: null,
        editorMode: 'visual',
        isAdminMode: false,
        operationLogs: [],
        publishStartedAt: null,
        publishTotal: 0,
        publishCompleted: 0,
        generationTimerInterval: null,
        generationStartedAt: null,
        generationTotal: 0,
        generationCompleted: 0,
        generationDurationsMs: [],
        generationFailed: [],
        publishDurationsMs: [],
        usageTotals: {
            calls: 0,
            inputTokens: 0,
            outputTokens: 0,
            estimatedCostUsd: 0,
        },
    },

    init() {
        this.state.isAdminMode = new URLSearchParams(window.location.search).get('admin') === '1';
        this.bindEvents();
        this.setAdminMode(this.state.isAdminMode);
        this.updateTypeFilterLabel();
        this.updateSelectionCounters();
        const savedSocialDir = localStorage.getItem('social-output-dir') || '';
        this.state.socialOutputDir = savedSocialDir;
        const socialDirInput = document.getElementById('social-output-dir');
        if (socialDirInput) socialDirInput.value = savedSocialDir;
        // Auto-focus input
        document.getElementById('dir-path').focus();
    },

    bindEvents() {
        document.getElementById('btn-load-dir').addEventListener('click', () => this.loadDirectory());

        // File picker events
        if (document.getElementById('btn-browse')) {
            document.getElementById('btn-browse').addEventListener('click', () => document.getElementById('dir-picker').click());
            document.getElementById('dir-picker').addEventListener('change', (e) => this.handleFileSelect(e));
        }

        document.getElementById('btn-confirm-clusters').addEventListener('click', () => this.startGeneration());
        document.getElementById('btn-publish-all').addEventListener('click', () => this.publishAll());
        document.getElementById('btn-open-social').addEventListener('click', () => this.goToStep(4));
        document.getElementById('btn-retry-failed').addEventListener('click', () => this.retryFailedGeneration());
        document.getElementById('btn-load-recent-posts').addEventListener('click', () => this.loadRecentPosts());
        document.getElementById('btn-select-all-social').addEventListener('click', () => this.setSocialSelection(true));
        document.getElementById('btn-select-none-social').addEventListener('click', () => this.setSocialSelection(false));
        document.getElementById('btn-generate-social-files').addEventListener('click', () => this.generateSocialFiles());

        const btnSelectAllClusters = document.getElementById('btn-select-all-clusters');
        const btnSelectNoneClusters = document.getElementById('btn-select-none-clusters');
        const adminToggle = document.getElementById('toggle-admin-mode');
        const filterTypeChecks = Array.from(document.querySelectorAll('.type-filter-check'));
        const sortClusters = document.getElementById('sort-story-clusters');
        const selectStoryType = document.getElementById('select-story-type');
        const btnSelectByType = document.getElementById('btn-select-clusters-by-type');
        const btnForceMerge = document.getElementById('btn-force-merge-clusters');
        const btnDownloadLogs = document.getElementById('btn-download-logs');
        const socialDirInput = document.getElementById('social-output-dir');

        if (btnSelectAllClusters) {
            btnSelectAllClusters.addEventListener('click', () => this.setClusterSelection(true));
        }
        if (btnSelectNoneClusters) {
            btnSelectNoneClusters.addEventListener('click', () => this.setClusterSelection(false));
        }
        if (adminToggle) {
            adminToggle.checked = this.state.isAdminMode;
            adminToggle.addEventListener('change', (e) => this.setAdminMode(e.target.checked));
        }
        if (filterTypeChecks.length) {
            filterTypeChecks.forEach(check => check.addEventListener('change', () => {
                const selected = filterTypeChecks.filter(item => item.checked).map(item => item.value);
                this.state.selectedStoryTypes = selected.length ? selected : [...STORY_TYPES];
                if (selected.length === 0) {
                    filterTypeChecks.forEach(item => { item.checked = true; });
                    this.state.selectedStoryTypes = [...STORY_TYPES];
                }
                this.updateTypeFilterLabel();
                this.renderClusters();
            }));
        }
        if (sortClusters) {
            sortClusters.addEventListener('change', (e) => {
                this.state.clusterSort = e.target.value;
                this.renderClusters();
            });
        }
        if (btnSelectByType && selectStoryType) {
            btnSelectByType.addEventListener('click', () => this.selectClustersByType(selectStoryType.value));
        }
        if (btnForceMerge) {
            btnForceMerge.addEventListener('click', () => this.forceMergeSelectedClusters());
        }
        if (btnDownloadLogs) {
            btnDownloadLogs.addEventListener('click', () => this.downloadLogs());
        }
        if (socialDirInput) {
            socialDirInput.addEventListener('input', (e) => {
                this.state.socialOutputDir = e.target.value.trim();
                localStorage.setItem('social-output-dir', this.state.socialOutputDir);
            });
        }

        document.addEventListener('change', (e) => {
            if (e.target.matches('.cluster-card .checkbox') || e.target.matches('.social-post-check')) {
                this.updateSelectionCounters();
            }
        });
    },

    updateTypeFilterLabel() {
        const label = document.getElementById('filter-story-type-label');
        if (!label) return;
        const selected = this.state.selectedStoryTypes;
        if (!selected.length || selected.length === STORY_TYPES.length) {
            label.innerText = 'All Types';
            return;
        }
        if (selected.length === 1) {
            label.innerText = selected[0].replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase());
            return;
        }
        label.innerText = `${selected.length} Types`;
    },

    setClusterSelection(checked) {
        document.querySelectorAll('.cluster-card .checkbox').forEach(cb => {
            const isDuplicate = cb.dataset.duplicate === 'true';
            cb.checked = checked ? !isDuplicate : false;
        });
        this.updateSelectionCounters();
    },

    setAdminMode(enabled) {
        this.state.isAdminMode = enabled;
        const toggle = document.getElementById('toggle-admin-mode');
        const panel = document.getElementById('admin-log-panel');
        document.querySelectorAll('.admin-only').forEach(el => el.classList.toggle('hidden', !enabled));
        if (toggle && toggle.checked !== enabled) toggle.checked = enabled;
        if (panel) panel.classList.toggle('hidden', !enabled);

        const url = new URL(window.location.href);
        if (enabled) url.searchParams.set('admin', '1');
        else url.searchParams.delete('admin');
        window.history.replaceState({}, '', url);
        this.logEvent('info', 'ui', enabled ? 'Admin mode enabled' : 'Admin mode disabled');
    },

    logEvent(level, stage, message, meta = {}) {
        const entry = {
            ts: new Date().toISOString(),
            level,
            stage,
            message,
            meta,
        };
        this.state.operationLogs.push(entry);
        if (this.state.operationLogs.length > 500) {
            this.state.operationLogs = this.state.operationLogs.slice(-500);
        }
        this.renderAdminLogs();
    },

    renderAdminLogs() {
        if (!this.state.isAdminMode) return;
        const container = document.getElementById('admin-log-list');
        if (!container) return;
        const recent = this.state.operationLogs.slice(-120).reverse();
        container.innerHTML = recent.map(row => `
      <div class="admin-log-row">
        <div><strong>[${this.escapeHtml(row.level.toUpperCase())}]</strong> ${this.escapeHtml(row.message)}</div>
        <div class="admin-log-meta">${this.escapeHtml(row.ts)} · ${this.escapeHtml(row.stage)} ${Object.keys(row.meta || {}).length ? `· ${this.escapeHtml(JSON.stringify(row.meta))}` : ''}</div>
      </div>
    `).join('');
    },

    downloadLogs() {
        const blob = new Blob([JSON.stringify(this.state.operationLogs, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `merge-publish-logs-${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
    },

    setPipelineStage(label, percent) {
        const statusEl = document.getElementById('status-indicator');
        const stageEl = document.getElementById('pipeline-stage-label');
        const progressEl = document.getElementById('pipeline-progress');
        const overview = document.getElementById('pipeline-overview');
        if (statusEl) statusEl.innerText = label;
        if (stageEl) stageEl.innerText = label;
        if (progressEl) progressEl.style.width = `${Math.max(0, Math.min(100, percent))}%`;
        if (overview) overview.classList.remove('hidden');
    },

    updateSelectionCounters() {
        const step2Count = document.querySelectorAll('.cluster-card .checkbox:checked').length;
        const step2Total = document.querySelectorAll('.cluster-card .checkbox').length;
        const step2DuplicateTotal = document.querySelectorAll('.cluster-card .checkbox[data-duplicate="true"]').length;
        const socialCount = document.querySelectorAll('.social-post-check:checked').length;

        const step2Label = document.getElementById('step2-selection-count');
        const socialLabel = document.getElementById('social-selection-count');
        const socialButton = document.getElementById('btn-generate-social-files');
        if (step2Label) step2Label.innerText = `Selected ${step2Count} of ${step2Total} · Existing coverage: ${step2DuplicateTotal}`;
        if (socialLabel) socialLabel.innerText = `Selected ${socialCount} posts`;
        if (socialButton) socialButton.disabled = socialCount === 0;
    },

    selectClustersByType(type) {
        document.querySelectorAll('.cluster-card .checkbox').forEach(cb => {
            const matches = cb.dataset.storyType === type;
            const isDuplicate = cb.dataset.duplicate === 'true';
            cb.checked = matches && !isDuplicate;
        });
        this.updateSelectionCounters();
    },

    formatDuration(ms) {
        const totalSeconds = Math.max(0, Math.floor(ms / 1000));
        const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
        const seconds = String(totalSeconds % 60).padStart(2, '0');
        return `${minutes}:${seconds}`;
    },

    startGenerationTimer() {
        const timerEl = document.getElementById('generation-timer');
        this.stopGenerationTimer();
        this.state.generationStartedAt = Date.now();
        if (timerEl) timerEl.innerText = '00:00';
        this.state.generationTimerInterval = setInterval(() => {
            if (!timerEl || !this.state.generationStartedAt) return;
            timerEl.innerText = this.formatDuration(Date.now() - this.state.generationStartedAt);
        }, 1000);
    },

    stopGenerationTimer() {
        if (this.state.generationTimerInterval) {
            clearInterval(this.state.generationTimerInterval);
            this.state.generationTimerInterval = null;
        }
    },

    updateGenerationProgress(label = '') {
        const done = this.state.generationCompleted;
        const total = this.state.generationTotal;
        const progressEl = document.getElementById('generation-overall-progress');
        const labelEl = document.getElementById('generation-overall-label');
        const etaEl = document.getElementById('generation-eta');
        const speedEl = document.getElementById('generation-speed');
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;

        if (progressEl) progressEl.style.width = `${pct}%`;
        if (labelEl) {
            const suffix = total > 0 ? `(${done}/${total})` : '';
            labelEl.innerText = label ? `${label} ${suffix}`.trim() : suffix;
        }

        const rolling = this.computeRollingEstimate(this.state.generationDurationsMs, this.state.generationStartedAt, done, total, GENERATION_ETA_WINDOW);
        if (etaEl) {
            if (done >= total && total > 0) etaEl.innerText = 'ETA 00:00';
            else if (rolling.mode === 'calibrating') etaEl.innerText = 'ETA calibrating...';
            else etaEl.innerText = `ETA ${this.formatDuration(rolling.remainingMs)}`;
        }
        if (speedEl) {
            speedEl.innerText = rolling.avgMs > 0 ? `Avg ${(rolling.avgMs / 1000).toFixed(1)}s/item` : 'Avg -- s/item';
        }
    },

    updatePublishProgress(label = '') {
        const done = this.state.publishCompleted;
        const total = this.state.publishTotal;
        const progressEl = document.getElementById('publish-overall-progress');
        const labelEl = document.getElementById('publish-overall-label');
        const etaEl = document.getElementById('publish-eta');
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;

        if (progressEl) progressEl.style.width = `${pct}%`;
        if (labelEl) {
            const suffix = total > 0 ? `(${done}/${total})` : '';
            labelEl.innerText = label ? `${label} ${suffix}`.trim() : suffix;
        }

        if (etaEl) {
            const rolling = this.computeRollingEstimate(this.state.publishDurationsMs, this.state.publishStartedAt, done, total, 5);
            if (done >= total && total > 0) {
                etaEl.innerText = 'ETA 00:00';
            } else if (rolling.mode === 'calibrating') {
                etaEl.innerText = 'ETA calibrating...';
            } else {
                etaEl.innerText = `ETA ${this.formatDuration(rolling.remainingMs)}`;
            }
        }
    },

    computeRollingEstimate(durations = [], startedAt = null, done = 0, total = 0, windowSize = 5) {
        const remainingItems = Math.max(0, (total || 0) - (done || 0));
        if (!startedAt || total <= 0 || remainingItems <= 0) {
            return { mode: 'idle', avgMs: 0, remainingMs: 0 };
        }
        if (done <= 0 || !durations.length) {
            return { mode: 'calibrating', avgMs: 0, remainingMs: 0 };
        }

        const window = durations.slice(-Math.max(1, windowSize));
        const avgMs = window.reduce((sum, value) => sum + value, 0) / window.length;
        return {
            mode: 'ready',
            avgMs,
            remainingMs: Math.max(0, avgMs * remainingItems),
        };
    },

    mergeUsageDelta(delta = {}) {
        const totals = this.state.usageTotals;
        totals.calls += Number(delta.calls || 0);
        totals.inputTokens += Number(delta.inputTokens || 0);
        totals.outputTokens += Number(delta.outputTokens || 0);
        totals.estimatedCostUsd += Number(delta.estimatedCostUsd || 0);
        this.renderUsageSummary();
    },

    renderUsageSummary() {
        const usageEl = document.getElementById('usage-summary');
        if (!usageEl) return;
        const usage = this.state.usageTotals;
        usageEl.innerText = `API calls ${usage.calls} · In ${usage.inputTokens} tok · Out ${usage.outputTokens} tok · Est $${usage.estimatedCostUsd.toFixed(4)}`;
    },

    normalizeLinkHover(container) {
        if (!container) return;
        container.querySelectorAll('a[href]').forEach((link) => {
            const href = (link.getAttribute('href') || '').trim();
            if (!href) return;
            link.setAttribute('title', href);
            link.setAttribute('data-href', href);
        });
    },

    buildGenerationCardMarkup({ cluster, article, diagnostics = {}, imagePreview = null }) {
        const quoteCount = Number(diagnostics?.quoteCount || 0);
        const longSentenceCount = Number(diagnostics?.longSentenceCount || 0);
        const relatedLinksCount = Number(diagnostics?.relatedLinksCount || 0);
        const sourceOk = diagnostics?.primarySourceLinked ? 'Primary source linked' : 'Primary source pending';
        const imageHtml = imagePreview?.url
            ? `<div class="generation-image-preview"><img src="${this.escapeHtml(imagePreview.url)}" alt="Preview for ${this.escapeHtml(cluster.headline || article.title || 'story')}" /><div class="generation-image-meta"><a href="${this.escapeHtml(imagePreview.sourceUrl || imagePreview.url)}" target="_blank" title="${this.escapeHtml(imagePreview.sourceUrl || imagePreview.url)}">${this.escapeHtml(imagePreview.sourceUrl || imagePreview.url)}</a></div></div>`
            : '<div class="generation-image-preview empty">No image preview detected</div>';

        return `
          <div class="generation-status-card">
            <div>
              <span>✅ Ready: <strong>${this.escapeHtml(article.title || cluster.headline || 'Untitled')}</strong></span>
              <div class="generation-diagnostics">
                <span>Quotes ${quoteCount}</span>
                <span>Long sentences ${longSentenceCount}</span>
                <span>Related links ${relatedLinksCount}</span>
                <span>${this.escapeHtml(sourceOk)}</span>
              </div>
            </div>
            ${imageHtml}
            <button class="btn-secondary" style="padding:0.25rem 0.5rem; font-size:0.8rem;" onclick="app.previewArticle(${cluster.cluster_id})">Preview</button>
          </div>
        `;
    },

    async requestWriteArticle(cluster) {
        const response = await fetch(`${API_BASE}/write-article-safe`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cluster }),
        });
        const payload = await response.json();
        if (!response.ok || !payload?.ok || payload?.error) {
            const message = payload?.error?.message || payload?.error || `HTTP ${response.status}`;
            const error = new Error(message);
            error.payload = payload;
            throw error;
        }
        return payload;
    },

    async processGenerationCluster(cluster, { retryAttempt = 0 } = {}) {
        const startedAt = Date.now();
        let attempts = retryAttempt;
        let completed = false;
        try {
            while (attempts <= 1 && !completed) {
                try {
                    const result = await this.requestWriteArticle(cluster);
                    const article = result.article;
                    this.state.generatedArticles[cluster.cluster_id] = article;
                    this.mergeUsageDelta(result.usage || {});

                    const statusDiv = document.getElementById(`proc-${cluster.cluster_id}`);
                    statusDiv.className = 'status-bar success';
                    statusDiv.innerHTML = this.buildGenerationCardMarkup({
                        cluster,
                        article,
                        diagnostics: result.diagnostics || article?.diagnostics || {},
                        imagePreview: article?.image_preview,
                    });

                    if (Object.keys(this.state.generatedArticles).length === 1) {
                        this.previewArticle(cluster.cluster_id);
                    }

                    this.logEvent('info', 'generate', 'Article generated', {
                        clusterId: cluster.cluster_id,
                        durationMs: result.durationMs || (Date.now() - startedAt),
                        retryAttempt: attempts,
                        diagnostics: result.diagnostics || {},
                        usage: result.usage || {},
                    });
                    completed = true;
                } catch (err) {
                    if (attempts < 1) {
                        this.logEvent('warn', 'generate', 'Generation failed, retrying once', {
                            clusterId: cluster.cluster_id,
                            error: err.message,
                        });
                        attempts += 1;
                        continue;
                    }

                    const payload = err?.payload || {};
                    this.mergeUsageDelta(payload?.usage || {});
                    this.state.generationFailed.push({
                        clusterId: cluster.cluster_id,
                        reason: err.message,
                    });
                    const statusDiv = document.getElementById(`proc-${cluster.cluster_id}`);
                    statusDiv.className = 'status-bar error';
                    statusDiv.innerHTML = `<span>❌ Failed: ${this.escapeHtml(cluster.headline)} (${this.escapeHtml(err.message)})</span>`;
                    this.logEvent('error', 'generate', 'Article generation failed', {
                        clusterId: cluster.cluster_id,
                        error: err.message,
                        diagnostics: payload?.diagnostics || {},
                    });
                    completed = true;
                }
            }
        } catch (err) {
            const statusDiv = document.getElementById(`proc-${cluster.cluster_id}`);
            statusDiv.className = 'status-bar error';
            statusDiv.innerHTML = `<span>❌ Failed: ${this.escapeHtml(cluster.headline)} (${this.escapeHtml(err.message)})</span>`;
            this.logEvent('error', 'generate', 'Article generation failed', {
                clusterId: cluster.cluster_id,
                error: err.message,
            });
        } finally {
            this.state.generationCompleted += 1;
            this.state.generationDurationsMs.push(Date.now() - startedAt);
            this.updateGenerationProgress('Generating articles...');
            document.getElementById('btn-retry-failed').disabled = this.state.generationFailed.length === 0;
        }
    },

    async runGenerationBatch(clusters = []) {
        let index = 0;
        const workers = Array.from({ length: Math.min(GENERATION_CONCURRENCY, clusters.length) }, async () => {
            while (index < clusters.length) {
                const cluster = clusters[index++];
                await this.processGenerationCluster(cluster);
            }
        });
        await Promise.all(workers);
    },

    escapeHtml(text = '') {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    },

    ensureDraft(clusterId) {
        if (!this.state.editorDrafts[clusterId] && this.state.generatedArticles[clusterId]) {
            this.state.editorDrafts[clusterId] = { ...this.state.generatedArticles[clusterId] };
        }
        return this.state.editorDrafts[clusterId];
    },

    markEditorSaved(message = 'Saved') {
        const el = document.getElementById('editor-save-indicator');
        if (el) el.innerText = message;
    },

    autosaveDraft(clusterId) {
        const draft = this.state.editorDrafts[clusterId];
        if (!draft) return;
        this.state.generatedArticles[clusterId] = { ...draft };
        this.markEditorSaved('Saved');
    },

    setEditorMode(mode) {
        this.state.editorMode = mode;
        const visualBtn = document.getElementById('btn-mode-visual');
        const htmlBtn = document.getElementById('btn-mode-html');
        const visualPanel = document.getElementById('editor-visual-panel');
        const htmlPanel = document.getElementById('editor-html-panel');

        if (visualBtn) visualBtn.classList.toggle('active', mode === 'visual');
        if (htmlBtn) htmlBtn.classList.toggle('active', mode === 'html');
        if (visualPanel) visualPanel.classList.toggle('hidden', mode !== 'visual');
        if (htmlPanel) htmlPanel.classList.toggle('hidden', mode !== 'html');
    },

    goToStep(step) {
        // Hide all steps
        document.querySelectorAll('.wizard-step').forEach(el => el.classList.remove('active'));
        document.querySelectorAll('.step-dot').forEach(el => el.classList.remove('active'));

        // Show current
        document.getElementById(`step-${step}`).classList.add('active');

        // Update dots
        for (let i = 1; i <= step; i++) {
            document.getElementById(`dot-${i}`).classList.add('active');
        }

        this.state.currentStep = step;

    },

    prevStep() {
        if (this.state.currentStep > 1) {
            this.goToStep(this.state.currentStep - 1);
        }
    },

    setLoading(btnId, isLoading) {
        const btn = document.getElementById(btnId);
        if (!btn) return;
        if (isLoading) {
            btn.dataset.originalText = btn.innerHTML;
            btn.innerHTML = '<div class="spinner"></div> Processing...';
            btn.disabled = true;
        } else {
            btn.innerHTML = btn.dataset.originalText || 'Continue';
            btn.disabled = false;
        }
    },

    // ─── Step 1: Load Directory ──────────────────────────────────────
    async handleFileSelect(event) {
        console.log('File selection triggered');
        const files = Array.from(event.target.files).filter(f => f.name.endsWith('.json'));
        if (files.length === 0) {
            console.warn('No JSON files found in selection');
            return alert('No JSON files found in selected directory');
        }

        console.log(`Found ${files.length} JSON files. Starting to read...`);
        this.setPipelineStage('Ingesting files...', 5);
        this.logEvent('info', 'ingest', 'File picker started', { files: files.length });
        this.setLoading('btn-browse', true);
        document.getElementById('dir-path').value = `Selected: ${files.length} files`;

        // Show progress UI
        const progressContainer = document.getElementById('loading-progress-container');
        const progressBar = document.getElementById('loading-progress');
        const statusText = document.getElementById('loading-status');
        progressContainer.classList.remove('hidden');

        const articles = [];
        const REQUIRED_FIELDS = ['title', 'main_content_body', 'source_url'];

        try {
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                const percent = Math.round(((i + 1) / files.length) * 100);
                if (progressBar) progressBar.style.width = `${percent}%`;
                if (statusText) statusText.innerText = `Processing ${i + 1} of ${files.length} files...`;
                this.setPipelineStage(`Ingesting files (${i + 1}/${files.length})...`, Math.max(5, Math.round(percent * 0.45)));

                try {
                    const text = await file.text();
                    const data = JSON.parse(text);

                    const missing = REQUIRED_FIELDS.filter(f => !data[f]);
                    if (missing.length === 0) {
                        articles.push({
                            ...data,
                            _filePath: file.webkitRelativePath || file.name,
                            _fileName: file.name
                        });
                    } else {
                        console.warn(`Skipping ${file.name}: Missing fields ${missing.join(', ')}`);
                    }
                } catch (e) {
                    console.error(`Failed to parse ${file.name}:`, e);
                }
            }

            console.log(`Successfully parsed ${articles.length} valid articles.`);
            if (statusText) statusText.innerText = `Finished! Processed ${articles.length} valid articles.`;
            this.logEvent('info', 'ingest', 'Completed JSON parsing', { validArticles: articles.length });

            if (articles.length === 0) {
                alert('No valid news articles found in selected files. Check field names (title, main_content_body, source_url).');
                this.setLoading('btn-browse', false);
                if (progressContainer) progressContainer.classList.add('hidden');
                return;
            }

            this.processLoadedArticles(articles);
            this.setLoading('btn-browse', false);
            // Hide progress UI after a short delay
            setTimeout(() => {
                if (progressContainer) progressContainer.classList.add('hidden');
            }, 2000);

        } catch (err) {
            console.error('Error during file processing:', err);
            this.logEvent('error', 'ingest', 'File processing failed', { error: err.message });
            alert(`Error reading files: ${err.message}`);
            this.setLoading('btn-browse', false);
            if (progressContainer) progressContainer.classList.add('hidden');
        }
    },

    async loadDirectory() {
        const pathInput = document.getElementById('dir-path');
        const dirPath = pathInput.value.trim();

        // If user used the picker, we might already have articles
        if (dirPath.startsWith('Selected:')) {
            if (this.state.articles.length > 0) {
                await this.clusterStories();
                return;
            }
        }

        if (!dirPath) return alert('Please enter a directory path');

        this.setLoading('btn-load-dir', true);
        this.setPipelineStage('Loading directory from server...', 8);
        this.logEvent('info', 'ingest', 'Loading directory path', { path: dirPath });

        try {
            const res = await fetch(`${API_BASE}/load-directory`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ directoryPath: dirPath })
            });
            const data = await res.json();

            if (data.error) throw new Error(data.error);

            this.processLoadedArticles(data.articles);

        } catch (err) {
            this.logEvent('error', 'ingest', 'Directory load failed', { error: err.message });
            alert(`Error: ${err.message}`);
            this.setLoading('btn-load-dir', false);
        }
    },

    async processLoadedArticles(articles) {
        this.state.articles = articles;
        // Sort by date manually if client-side loaded, though backend does it too.
        this.state.articles.sort((a, b) => {
            const da = a.date_time ? new Date(a.date_time) : new Date(0);
            const db = b.date_time ? new Date(b.date_time) : new Date(0);
            return da - db;
        });

        document.getElementById('file-stats').innerHTML = `<p class="badge-new">Loaded ${articles.length} articles</p>`;
        document.getElementById('file-stats').classList.remove('hidden');
        this.setPipelineStage(`Loaded ${articles.length} articles.`, 25);
        this.logEvent('info', 'ingest', 'Articles loaded into client state', { count: articles.length });

        // Proceed to clustering immediately
        await this.clusterStories();
    },

    // ─── Step 2: Cluster Stories ─────────────────────────────────────
    async clusterStories() {
        console.log('Starting story clustering for', this.state.articles.length, 'articles...');
        this.logEvent('info', 'cluster', 'Starting clustering', { articles: this.state.articles.length });
        this.setPipelineStage('Clustering stories...', 35);
        this.setLoading('btn-load-dir', true); // Show loading on the main button too

        try {
            const res = await fetch(`${API_BASE}/cluster-stories`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ articles: this.state.articles })
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error);

            console.log(`Received ${data.clusters.length} clusters. Checking for duplicates...`);
            this.logEvent('info', 'cluster', 'Clusters returned', { clusters: data.clusters.length });
            this.setPipelineStage('Checking existing coverage...', 62);

            // Check duplicates
            const dupRes = await fetch(`${API_BASE}/check-duplicates`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ clusters: data.clusters })
            });
            const dupData = await dupRes.json();

            this.state.clusters = dupData.clusters;
            this.renderClusters();
            console.log('Clustering and duplicate check complete.');
            this.logEvent('info', 'cluster', 'Duplicate check complete', {
                clusters: dupData.clusters.length,
                duplicates: dupData.clusters.filter(c => c.duplicate).length,
            });
            this.setPipelineStage('Review stories ready.', 100);

            this.setLoading('btn-load-dir', false);
            this.goToStep(2);

        } catch (err) {
            console.error('Clustering failed:', err);
            this.logEvent('error', 'cluster', 'Clustering failed', { error: err.message });
            alert(`Clustering failed: ${err.message}`);
            this.setLoading('btn-load-dir', false);
        }
    },

    renderClusters() {
        const container = document.getElementById('clusters-container');
        container.innerHTML = '';

        let clusters = [...this.state.clusters];
        const selectedTypes = this.state.selectedStoryTypes || [];
        clusters = clusters.filter(cluster => selectedTypes.includes(cluster.story_type || 'other'));

        if (this.state.clusterSort === 'date_desc') {
            clusters.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
        } else if (this.state.clusterSort === 'date_asc') {
            clusters.sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
        } else if (this.state.clusterSort === 'type') {
            clusters.sort((a, b) => (a.story_type || 'other').localeCompare(b.story_type || 'other'));
        } else if (this.state.clusterSort === 'sources_desc') {
            clusters.sort((a, b) => (b.article_count || 0) - (a.article_count || 0));
        }

        clusters.forEach(cluster => {
            const isDuplicate = cluster.duplicate;
            const storyType = cluster.story_type || 'other';
            const el = document.createElement('div');
            el.className = `card cluster-card ${isDuplicate ? 'duplicate' : ''}`;

            const sourcesHtml = cluster.sources.map(s =>
                `<div>• <a href="${s.url}" target="_blank">${s.name}</a>: ${s.title}</div>`
            ).join('');

            el.innerHTML = `
        <input type="checkbox" class="checkbox" 
          data-id="${cluster.cluster_id}"
          data-story-type="${storyType}"
          data-duplicate="${isDuplicate ? 'true' : 'false'}"
          ${!isDuplicate ? 'checked' : ''}>
        
        <div class="cluster-details">
          <div class="cluster-meta">
            ${isDuplicate ? '<span class="badge badge-duplicate">Existing Coverage</span>' : '<span class="badge badge-new">New Story</span>'}
            <span class="story-type-badge">${storyType.replace('_', ' ')}</span>
            <span>${cluster.article_count} sources</span>
            <span>${new Date(cluster.date).toLocaleString()}</span>
          </div>
          
          <h4>${cluster.headline}</h4>
          <p>${cluster.summary}</p>
          
          ${isDuplicate ? `<p style="color:var(--accent-danger); font-size:0.9rem;">Duplicate of: <a href="${cluster.duplicate_of.link}" target="_blank">${cluster.duplicate_of.title}</a></p>` : ''}
          
          <details>
            <summary style="cursor:pointer; font-size:0.85rem; color:var(--text-secondary);">View Sources</summary>
            <div class="source-list">${sourcesHtml}</div>
          </details>
        </div>
      `;
            container.appendChild(el);
        });

        this.updateSelectionCounters();
    },

    // ─── Step 3: Generation ──────────────────────────────────────────
    async startGeneration() {
        // Get final selection
        const toProcessIds = new Set();
        document.querySelectorAll('.cluster-card .checkbox:checked').forEach(cb => {
            toProcessIds.add(parseInt(cb.dataset.id));
        });

        if (toProcessIds.size === 0) return alert('No stories selected for writing.');

        this.logEvent('info', 'generate', 'Starting article generation', { selected: toProcessIds.size });
        this.setPipelineStage('Generating articles...', 78);

        this.goToStep(3);
        const progressEl = document.getElementById('generation-progress');
        progressEl.innerHTML = '';

        const clustersToProcess = this.state.clusters.filter(c => toProcessIds.has(c.cluster_id));
        this.state.generationTotal = clustersToProcess.length;
        this.state.generationCompleted = 0;
        this.state.generationDurationsMs = [];
        this.state.generationFailed = [];
        this.startGenerationTimer();
        this.updateGenerationProgress('Starting generation...');
        document.getElementById('btn-retry-failed').disabled = true;

        // Create placeholders
        clustersToProcess.forEach(c => {
            const div = document.createElement('div');
            div.id = `proc-${c.cluster_id}`;
            div.className = 'status-bar';
            div.innerHTML = `<span>Writing: ${c.headline}...</span> <div class="spinner"></div>`;
            progressEl.appendChild(div);
        });

        await this.runGenerationBatch(clustersToProcess);

        this.stopGenerationTimer();
        this.updateGenerationProgress('Generation complete');
        this.setPipelineStage('Generation complete. Ready to publish.', 90);
        this.logEvent('info', 'generate', 'Article generation completed', {
            generated: this.state.generationCompleted,
            failed: this.state.generationFailed.length,
        });

        document.getElementById('btn-publish-all').disabled = false;
    },

    async retryFailedGeneration() {
        const failedIds = new Set(this.state.generationFailed.map(item => item.clusterId));
        if (!failedIds.size) return;

        const clusters = this.state.clusters.filter(cluster => failedIds.has(cluster.cluster_id));
        this.state.generationTotal = clusters.length;
        this.state.generationCompleted = 0;
        this.state.generationDurationsMs = [];
        this.state.generationFailed = [];
        document.getElementById('btn-retry-failed').disabled = true;
        this.logEvent('info', 'generate', 'Retrying failed articles', { count: clusters.length });
        await this.runGenerationBatch(clusters);
        this.updateGenerationProgress('Retry pass complete');
        this.logEvent('info', 'generate', 'Retry failed-only pass complete', {
            remainingFailed: this.state.generationFailed.length,
        });
    },

    async forceMergeSelectedClusters() {
        if (!this.state.isAdminMode) return;

        const selectedIds = Array.from(document.querySelectorAll('.cluster-card .checkbox:checked'))
            .map(cb => parseInt(cb.dataset.id, 10));

        if (selectedIds.length < 2) {
            alert('Select at least two clusters to force merge.');
            return;
        }

        try {
            const res = await fetch(`${API_BASE}/learn-force-merge`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    clusters: this.state.clusters.filter(c => selectedIds.includes(c.cluster_id)),
                }),
            });
            const data = await res.json();
            if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);

            this.state.clusters = this.state.clusters.filter(c => !selectedIds.includes(c.cluster_id));
            this.state.clusters.push(data.mergedCluster);
            this.renderClusters();
            this.logEvent('info', 'cluster', 'Force merge applied', {
                mergedCount: selectedIds.length,
                learnedRules: data.learnedRules,
            });
        } catch (err) {
            this.logEvent('error', 'cluster', 'Force merge failed', { error: err.message });
            alert(`Force merge failed: ${err.message}`);
        }
    },

    previewArticle(clusterId) {
        const article = this.state.generatedArticles[clusterId];
        if (!article) return;

        this.state.previewingClusterId = clusterId;
        const draft = this.ensureDraft(clusterId);

        const container = document.getElementById('preview-container');
        container.innerHTML = `
      <div class="editor-toolbar">
        <div class="editor-mode-toggle">
          <button type="button" id="btn-mode-visual" class="btn-secondary editor-mode-btn">Visual</button>
          <button type="button" id="btn-mode-html" class="btn-secondary editor-mode-btn">HTML</button>
        </div>
        <div id="editor-save-indicator">Saved</div>
      </div>
      <div id="editor-visual-panel" class="article-preview editor-panel">
        <p class="article-meta-line">Slug: ${this.escapeHtml(draft.slug || '')} | Tags: ${this.escapeHtml((draft.tags || []).join(', '))}</p>
        <input id="editor-title" class="editor-title-input" type="text" value="${this.escapeHtml(draft.title || '')}" />
        <textarea id="editor-meta" class="editor-meta-input" rows="2">${this.escapeHtml(draft.meta_description || '')}</textarea>
        <hr style="margin: 1.25rem 0; opacity:0.2;">
        <div id="editor-visual-body" class="editor-visual-body" contenteditable="true">${draft.body_html || ''}</div>
      </div>
      <div id="editor-html-panel" class="editor-panel hidden">
        <textarea id="editor-html-body" class="editor-html-input" rows="16"></textarea>
      </div>
    `;

        const titleInput = document.getElementById('editor-title');
        const metaInput = document.getElementById('editor-meta');
        const visualBody = document.getElementById('editor-visual-body');
        const htmlBody = document.getElementById('editor-html-body');
        const visualModeBtn = document.getElementById('btn-mode-visual');
        const htmlModeBtn = document.getElementById('btn-mode-html');

        htmlBody.value = draft.body_html || '';
        this.normalizeLinkHover(visualBody);

        const onMetaChange = () => {
            draft.title = titleInput.value;
            draft.meta_description = metaInput.value;
            this.markEditorSaved('Saving...');
            this.autosaveDraft(clusterId);
        };

        const onVisualChange = () => {
            draft.body_html = visualBody.innerHTML;
            htmlBody.value = draft.body_html;
            this.normalizeLinkHover(visualBody);
            this.markEditorSaved('Saving...');
            this.autosaveDraft(clusterId);
        };

        const onHtmlChange = () => {
            draft.body_html = htmlBody.value;
            visualBody.innerHTML = draft.body_html;
            this.normalizeLinkHover(visualBody);
            this.markEditorSaved('Saving...');
            this.autosaveDraft(clusterId);
        };

        titleInput.addEventListener('input', onMetaChange);
        metaInput.addEventListener('input', onMetaChange);
        visualBody.addEventListener('input', onVisualChange);
        htmlBody.addEventListener('input', onHtmlChange);

        visualModeBtn.addEventListener('click', () => this.setEditorMode('visual'));
        htmlModeBtn.addEventListener('click', () => this.setEditorMode('html'));
        this.setEditorMode(this.state.editorMode);

        container.scrollIntoView({ behavior: 'smooth' });
    },

    buildFirstSentence(post = {}) {
        const plain = this.stripHtml(post?.content || post?.excerpt || post?.summary || '');
        const sentence = (plain.match(/[^.!?]+[.!?]/) || [plain])[0] || '';
        return sentence.trim();
    },

    stripHtml(text = '') {
        return String(text).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    },

    truncateAtWordBoundary(text = '', max = 250) {
        const clean = this.stripHtml(text);
        if (clean.length <= max) return clean;
        const cut = clean.slice(0, max + 1);
        const lastSpace = cut.lastIndexOf(' ');
        return (lastSpace > 40 ? cut.slice(0, lastSpace) : clean.slice(0, max)).trim();
    },

    buildXText(post = {}) {
        const summary = this.truncateAtWordBoundary(post.summary || this.buildFirstSentence(post), 220);
        const url = post.link || '';
        return this.truncateAtWordBoundary(`${summary}\n\n${url}`, 280);
    },

    buildWhatsappText(post = {}) {
        const oneLine = this.truncateAtWordBoundary(this.buildFirstSentence(post), 220);
        return `${oneLine}\n${post.link || ''}`;
    },

    buildRedditSubmitUrl(post = {}) {
        const title = post.title || 'Barna.News update';
        const text = `${this.buildFirstSentence(post)}\n\n${post.link || ''}`;
        return `https://www.reddit.com/submit?title=${encodeURIComponent(title)}&text=${encodeURIComponent(text)}`;
    },

    buildXIntentUrl(post = {}) {
        const text = this.buildXText(post);
        return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
    },

    renderRecentPosts() {
        const container = document.getElementById('recent-posts-container');
        if (!container) return;
        if (!this.state.recentPosts.length) {
            container.innerHTML = '<p>No recent posts loaded yet.</p>';
            this.updateSelectionCounters();
            return;
        }

        container.innerHTML = this.state.recentPosts.map(post => {
            const checked = this.state.selectedSocialPostIds.has(post.id) ? 'checked' : '';
            return `
        <div class="card cluster-card">
          <input type="checkbox" class="checkbox social-post-check" data-id="${post.id}" ${checked}>
          <div class="cluster-details">
            <div class="cluster-meta">
              <span class="badge ${post.status === 'publish' ? 'badge-new' : 'badge-duplicate'}">${post.status}</span>
              <span>${new Date(post.date).toLocaleString()}</span>
            </div>
            <h4>${this.escapeHtml(post.title || 'Untitled')}</h4>
            <p>${this.escapeHtml(this.truncateAtWordBoundary(post.summary || '', 220))}</p>
            <a href="${post.link}" target="_blank">${this.escapeHtml(post.link || '')}</a>
          </div>
        </div>
      `;
        }).join('');

        container.querySelectorAll('.social-post-check').forEach(cb => {
            cb.addEventListener('change', () => {
                const id = Number(cb.dataset.id);
                if (cb.checked) this.state.selectedSocialPostIds.add(id);
                else this.state.selectedSocialPostIds.delete(id);
                this.updateSelectionCounters();
            });
        });

        this.updateSelectionCounters();
    },

    async loadRecentPosts() {
        const button = document.getElementById('btn-load-recent-posts');
        this.setLoading('btn-load-recent-posts', true);
        try {
            const res = await fetch(`${API_BASE}/recent-posts?limit=40`);
            const data = await res.json();
            if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);

            this.state.recentPosts = Array.isArray(data.posts) ? data.posts : [];
            this.state.selectedSocialPostIds = new Set(this.state.recentPosts.map(post => post.id));
            this.renderRecentPosts();
        } catch (err) {
            alert(`Failed to load recent posts: ${err.message}`);
        } finally {
            if (button) this.setLoading('btn-load-recent-posts', false);
        }
    },

    setSocialSelection(checked) {
        if (checked) {
            this.state.selectedSocialPostIds = new Set(this.state.recentPosts.map(post => post.id));
        } else {
            this.state.selectedSocialPostIds.clear();
        }
        this.renderRecentPosts();
    },

    createHtmlBlobUrl(content) {
        const blob = new Blob([content], { type: 'text/html;charset=utf-8' });
        return URL.createObjectURL(blob);
    },

    buildSocialHtml({ platform, posts, renderBody, renderActions }) {
        const rows = posts.map((post, idx) => {
            const body = renderBody(post);
            const actions = typeof renderActions === 'function' ? renderActions(post) : '';
            return `
        <article class="item">
          <h2>${idx + 1}. ${this.escapeHtml(post.title || 'Untitled')}</h2>
          <pre>${this.escapeHtml(body)}</pre>
          ${actions}
        </article>`;
        }).join('\n');

        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${platform} Social Export</title>
  <style>body{font-family:Arial,sans-serif;padding:24px;line-height:1.5}pre{white-space:pre-wrap;background:#f5f7fb;padding:12px;border-radius:8px}.item{margin-bottom:20px}.actions a{display:inline-block;margin-right:10px;margin-top:8px;color:#0b63ce}</style>
</head>
<body>
  <h1>${platform} Social Export (${posts.length} posts)</h1>
  ${rows}
</body>
</html>`;
    },

    async generateSocialFiles() {
        const selected = this.state.recentPosts.filter(post => this.state.selectedSocialPostIds.has(post.id));
        if (!selected.length) {
            alert('Select at least one post for social export.');
            return;
        }

        const redditHtml = this.buildSocialHtml({
            platform: 'Reddit',
            posts: selected,
            renderBody: (post) => `${this.buildFirstSentence(post)}\n\n${post.link || ''}`,
            renderActions: (post) => `<div class="actions"><a href="${this.buildRedditSubmitUrl(post)}" target="_blank">Open prefilled Reddit post</a></div>`,
        });
        const xHtml = this.buildSocialHtml({
            platform: 'X',
            posts: selected,
            renderBody: (post) => this.buildXText(post),
            renderActions: (post) => `<div class="actions"><a href="${this.buildXIntentUrl(post)}" target="_blank">Open prefilled X post</a></div>`,
        });
        const whatsappHtml = this.buildSocialHtml({
            platform: 'WhatsApp',
            posts: selected,
            renderBody: (post) => this.buildWhatsappText(post),
        });

        const redditUrl = this.createHtmlBlobUrl(redditHtml);
        const xUrl = this.createHtmlBlobUrl(xHtml);
        const whatsappUrl = this.createHtmlBlobUrl(whatsappHtml);
        const redditFileName = `reddit_${selected.length}_articles.html`;
        const xFileName = `x_${selected.length}_articles.html`;
        const whatsappFileName = `copy_${selected.length}_fixed.html`;
        const outputDir = (document.getElementById('social-output-dir')?.value || this.state.socialOutputDir || '').trim();

        let saveSummaryHtml = '<p style="font-size:0.85rem; color:var(--text-secondary);">Use the download links below, or set an output folder to save automatically.</p>';
        if (outputDir) {
            try {
                const saveRes = await fetch(`${API_BASE}/save-social-html`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        outputDir,
                        files: [
                            { name: xFileName, content: xHtml },
                            { name: redditFileName, content: redditHtml },
                            { name: whatsappFileName, content: whatsappHtml },
                        ],
                    }),
                });
                const saveData = await saveRes.json();
                if (!saveRes.ok || saveData.error) throw new Error(saveData.error || `HTTP ${saveRes.status}`);
                const savedItems = (saveData.saved || []).map(item => `<li>${this.escapeHtml(item)}</li>`).join('');
                saveSummaryHtml = `<p style="font-size:0.85rem; color:var(--text-secondary);">Saved to: ${this.escapeHtml(outputDir)}</p><ul>${savedItems}</ul>`;
            } catch (err) {
                saveSummaryHtml = `<p style="font-size:0.85rem; color:var(--accent-danger);">Auto-save failed: ${this.escapeHtml(err.message)}</p>`;
            }
        }

        const result = document.getElementById('social-files-result');
        result.classList.remove('hidden');
        result.innerHTML = `
      <h3>Generated Social HTML Files</h3>
      <p>Open each file and copy/paste or use prepared posting links:</p>
      <ul>
        <li><a href="${xUrl}" target="_blank" download="${xFileName}">${xFileName}</a></li>
        <li><a href="${redditUrl}" target="_blank" download="${redditFileName}">${redditFileName}</a></li>
        <li><a href="${whatsappUrl}" target="_blank" download="${whatsappFileName}">${whatsappFileName}</a></li>
      </ul>
      ${saveSummaryHtml}
    `;
    },

    // ─── Step 4: Publish ─────────────────────────────────────────────
    async publishAll() {
        if (!confirm('This will create DRAFT posts in WordPress. Continue?')) return;

        this.setLoading('btn-publish-all', true);
        const articles = Object.values(this.state.generatedArticles);
        this.state.publishStartedAt = Date.now();
        this.state.publishTotal = articles.length;
        this.state.publishCompleted = 0;
        this.state.publishDurationsMs = [];
        this.updatePublishProgress('Starting publish...');
        this.setPipelineStage('Publishing drafts to WordPress...', 92);
        this.logEvent('info', 'publish', 'Publish flow started', { total: articles.length });

        for (const article of articles) {
            const startedAt = Date.now();
            try {
                this.updatePublishProgress(`Publishing ${article.title}...`);
                const res = await fetch(`${API_BASE}/publish-draft`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ article })
                });

                const raw = await res.text();
                let data = {};
                try {
                    data = raw ? JSON.parse(raw) : {};
                } catch {
                    data = { error: raw || `HTTP ${res.status}` };
                }

                if (!res.ok) {
                    throw new Error(data.error || `Publish request failed (${res.status})`);
                }

                if (data.error) throw new Error(data.error);
                this.mergeUsageDelta(data.usage || {});

                // Mark as published in UI
                const statusDiv = document.getElementById(`proc-${article.cluster_id}`);
                statusDiv.innerHTML = `
          <span>🚀 Published Draft: <a href="${data.result.editLink}" target="_blank" style="color:inherit; text-decoration:underline;">Edit in WordPress</a></span>
        `;
                this.logEvent('info', 'publish', 'Draft published', {
                    clusterId: article.cluster_id,
                    editLink: data.result.editLink,
                    usage: data.usage || {},
                });

            } catch (err) {
                this.logEvent('error', 'publish', 'Draft publish failed', {
                    clusterId: article.cluster_id,
                    error: err.message,
                });
                alert(`Publish failed for "${article.title}": ${err.message}`);
            } finally {
                this.state.publishCompleted += 1;
                this.state.publishDurationsMs.push(Date.now() - startedAt);
                this.updatePublishProgress('Publishing drafts...');
            }
        }

        this.setLoading('btn-publish-all', false);
        document.getElementById('btn-publish-all').innerText = 'All Done!';
        document.getElementById('btn-open-social').disabled = false;
        this.updatePublishProgress('Publish complete');
        this.setPipelineStage('Workflow complete.', 100);
        this.logEvent('info', 'publish', 'Publish flow complete', {
            published: this.state.publishCompleted,
        });
    }
};

document.addEventListener('DOMContentLoaded', () => app.init());
