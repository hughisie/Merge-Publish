const API_BASE = '/api';
const STORY_TYPES = ['news', 'feature', 'interview', 'opinion', 'review', 'recommendation', 'whats_on', 'history', 'other'];
function resolveGenerationConcurrency() {
    const params = new URLSearchParams(window.location.search);
    const fromQuery = Number(params.get('concurrency'));
    const fromStorage = Number(localStorage.getItem('generation-concurrency'));
    const candidate = Number.isFinite(fromQuery) && fromQuery > 0 ? fromQuery : fromStorage;
    return Math.max(1, Math.min(6, Number.isFinite(candidate) && candidate > 0 ? Math.floor(candidate) : 3));
}

const GENERATION_CONCURRENCY = resolveGenerationConcurrency();
const GENERATION_ETA_WINDOW = 5;
const ARTICLE_REQUEST_TIMEOUT_MS = 12 * 60 * 1000;
const PUBLISH_ATTEMPTS = 2;
const PUBLISH_RETRY_BASE_DELAY_MS = 800;
const DEFAULT_WHATSAPP_CHANNELS = [
    {
        id: 'broadcast_channel',
        label: 'Broadcast Channel',
        url: 'https://whatsapp.com/channel/0029Vb6PJDh6WaKjaAcWAX1h',
        to: '0029Vb6PJDh6WaKjaAcWAX1h@newsletter',
        mode: 'open_url',
    },
    {
        id: 'news_flash',
        label: 'News-Flash',
        url: 'https://chat.whatsapp.com/',
        to: '120363269876975950@g.us',
        mode: 'api',
    },
];

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
        publishSuccess: 0,
        publishFailed: 0,
        publishFailures: [],
        isPublishing: false,
        autoPublishAfterGeneration: false,
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
            byStage: {},
            byStageModels: {},
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
        document.getElementById('btn-top-load')?.addEventListener('click', () => this.goToStep(1));
        document.getElementById('btn-reset-workflow')?.addEventListener('click', () => this.resetWorkflowState());

        // File picker events
        if (document.getElementById('btn-browse')) {
            document.getElementById('btn-browse').addEventListener('click', () => document.getElementById('dir-picker').click());
            document.getElementById('dir-picker').addEventListener('change', (e) => this.handleFileSelect(e));
        }

        document.getElementById('btn-confirm-clusters').addEventListener('click', () => this.startGeneration());
        document.getElementById('btn-generate-publish').addEventListener('click', () => this.startGenerateAndPublish());
        document.getElementById('btn-generate-publish-review')?.addEventListener('click', () => this.startGenerateAndPublish());
        document.getElementById('btn-publish-all').addEventListener('click', () => this.publishAll());
        document.getElementById('btn-retry-failed-publish').addEventListener('click', () => this.retryFailedPublishes());
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
        const success = this.state.publishSuccess;
        const failed = this.state.publishFailed;
        const progressEl = document.getElementById('publish-overall-progress');
        const labelEl = document.getElementById('publish-overall-label');
        const etaEl = document.getElementById('publish-eta');
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;

        if (progressEl) progressEl.style.width = `${pct}%`;
        if (labelEl) {
            const summary = `Published ${success} / Total ${total} · Failed ${failed}`;
            labelEl.innerText = label ? `${label} · ${summary}` : summary;
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
        this.renderPublishOutcomeSummary();
    },

    renderPublishOutcomeSummary() {
        const el = document.getElementById('publish-outcome-summary');
        if (!el) return;
        el.innerText = `Published ${this.state.publishSuccess} / Total ${this.state.publishTotal} · Failed ${this.state.publishFailed}`;
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

        const byStage = delta.byStage || {};
        Object.entries(byStage).forEach(([stage, usage]) => {
            if (!totals.byStage[stage]) {
                totals.byStage[stage] = { calls: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
            }
            totals.byStage[stage].calls += Number(usage.calls || 0);
            totals.byStage[stage].inputTokens += Number(usage.inputTokens || 0);
            totals.byStage[stage].outputTokens += Number(usage.outputTokens || 0);
            totals.byStage[stage].estimatedCostUsd += Number(usage.estimatedCostUsd || 0);
        });

        const byStageModels = delta.byStageModels || {};
        Object.entries(byStageModels).forEach(([stage, models]) => {
            if (!totals.byStageModels[stage]) totals.byStageModels[stage] = {};
            Object.entries(models || {}).forEach(([model, usage]) => {
                if (!totals.byStageModels[stage][model]) {
                    totals.byStageModels[stage][model] = { calls: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
                }
                totals.byStageModels[stage][model].calls += Number(usage.calls || 0);
                totals.byStageModels[stage][model].inputTokens += Number(usage.inputTokens || 0);
                totals.byStageModels[stage][model].outputTokens += Number(usage.outputTokens || 0);
                totals.byStageModels[stage][model].estimatedCostUsd += Number(usage.estimatedCostUsd || 0);
            });
        });

        this.renderUsageSummary();
    },

    renderUsageSummary() {
        const usageEl = document.getElementById('usage-summary');
        const breakdownEl = document.getElementById('usage-stage-breakdown');
        if (!usageEl) return;
        const usage = this.state.usageTotals;
        usageEl.innerText = `API calls ${usage.calls} · In ${usage.inputTokens} tok · Out ${usage.outputTokens} tok · Est $${usage.estimatedCostUsd.toFixed(4)}`;

        if (!breakdownEl) return;
        const rows = Object.entries(usage.byStage || {})
            .sort((a, b) => Number(b[1]?.estimatedCostUsd || 0) - Number(a[1]?.estimatedCostUsd || 0));

        if (!rows.length) {
            breakdownEl.innerText = 'No stage usage recorded yet.';
            return;
        }

        breakdownEl.innerHTML = rows.map(([stage, row]) => {
            const modelMap = usage.byStageModels?.[stage] || {};
            const models = Object.entries(modelMap)
                .sort((a, b) => Number(b[1]?.calls || 0) - Number(a[1]?.calls || 0))
                .map(([model, modelRow]) => `${this.escapeHtml(model)} (${Number(modelRow.calls || 0)} calls)`)
                .join(', ');
            return `<div class="usage-stage-row"><strong>${this.escapeHtml(stage)}</strong> · ${Number(row.calls || 0)} calls · In ${Number(row.inputTokens || 0)} · Out ${Number(row.outputTokens || 0)} · $${Number(row.estimatedCostUsd || 0).toFixed(4)}${models ? ` · Models: ${models}` : ''}</div>`;
        }).join('');
    },

    async sleep(ms) {
        await new Promise(resolve => setTimeout(resolve, ms));
    },

    isRetryablePublishError(err) {
        if (err?.retryable === true) return true;
        const status = Number(err?.status || 0);
        const message = String(err?.message || '').toLowerCase();
        if (status >= 500 || status === 408 || status === 429) return true;
        return message.includes('failed to fetch') || message.includes('network') || message.includes('socket') || message.includes('timeout');
    },

    resetPublishState(total = 0) {
        this.state.publishStartedAt = Date.now();
        this.state.publishTotal = total;
        this.state.publishCompleted = 0;
        this.state.publishSuccess = 0;
        this.state.publishFailed = 0;
        this.state.publishDurationsMs = [];
        this.state.publishFailures = [];
        const retryBtn = document.getElementById('btn-retry-failed-publish');
        if (retryBtn) retryBtn.disabled = true;
        this.renderPublishOutcomeSummary();
    },

    resetWorkflowState() {
        this.stopGenerationTimer();

        this.state.currentStep = 1;
        this.state.directoryPath = '';
        this.state.articles = [];
        this.state.clusters = [];
        this.state.selectedStoryTypes = [...STORY_TYPES];
        this.state.clusterSort = 'date_desc';
        this.state.selectedClusterIds = new Set();
        this.state.generatedArticles = {};
        this.state.recentPosts = [];
        this.state.selectedSocialPostIds = new Set();
        this.state.editorDrafts = {};
        this.state.previewingClusterId = null;
        this.state.operationLogs = [];
        this.state.publishStartedAt = null;
        this.state.publishTotal = 0;
        this.state.publishCompleted = 0;
        this.state.publishSuccess = 0;
        this.state.publishFailed = 0;
        this.state.publishFailures = [];
        this.state.isPublishing = false;
        this.state.autoPublishAfterGeneration = false;
        this.state.generationTimerInterval = null;
        this.state.generationStartedAt = null;
        this.state.generationTotal = 0;
        this.state.generationCompleted = 0;
        this.state.generationDurationsMs = [];
        this.state.generationFailed = [];
        this.state.publishDurationsMs = [];
        this.state.usageTotals = {
            calls: 0,
            inputTokens: 0,
            outputTokens: 0,
            estimatedCostUsd: 0,
            byStage: {},
            byStageModels: {},
        };

        const dirPathEl = document.getElementById('dir-path');
        const dirPickerEl = document.getElementById('dir-picker');
        const fileStatsEl = document.getElementById('file-stats');
        const clustersEl = document.getElementById('clusters-container');
        const generationEl = document.getElementById('generation-progress');
        const previewEl = document.getElementById('preview-container');
        const postsEl = document.getElementById('recent-posts-container');
        const socialResultEl = document.getElementById('social-files-result');
        const loadingContainerEl = document.getElementById('loading-progress-container');
        const loadingBarEl = document.getElementById('loading-progress');
        const loadingStatusEl = document.getElementById('loading-status');
        const sortEl = document.getElementById('sort-story-clusters');

        if (dirPathEl) dirPathEl.value = '';
        if (dirPickerEl) dirPickerEl.value = '';
        if (fileStatsEl) {
            fileStatsEl.innerHTML = '';
            fileStatsEl.classList.add('hidden');
        }
        if (clustersEl) clustersEl.innerHTML = '';
        if (generationEl) generationEl.innerHTML = '';
        if (previewEl) previewEl.innerHTML = '';
        if (postsEl) postsEl.innerHTML = '<p>No recent posts loaded yet.</p>';
        if (socialResultEl) {
            socialResultEl.innerHTML = '';
            socialResultEl.classList.add('hidden');
        }
        if (loadingContainerEl) loadingContainerEl.classList.add('hidden');
        if (loadingBarEl) loadingBarEl.style.width = '0%';
        if (loadingStatusEl) loadingStatusEl.innerText = 'Reading files...';
        if (sortEl) sortEl.value = 'date_desc';

        document.querySelectorAll('.type-filter-check').forEach((check) => { check.checked = true; });
        const retryGenBtn = document.getElementById('btn-retry-failed');
        const retryPublishBtn = document.getElementById('btn-retry-failed-publish');
        const publishBtn = document.getElementById('btn-publish-all');
        if (retryGenBtn) retryGenBtn.disabled = true;
        if (retryPublishBtn) retryPublishBtn.disabled = true;
        if (publishBtn) publishBtn.disabled = true;

        this.goToStep(1);
        this.setPipelineStage('Ready', 0);
        this.updateTypeFilterLabel();
        this.updateSelectionCounters();
        this.renderUsageSummary();
        this.updateGenerationProgress('Ready to generate.');
        this.renderPublishOutcomeSummary();
        this.updatePublishProgress('Ready to publish.');
        this.renderAdminLogs();
        this.logEvent('info', 'ui', 'Workflow reset');

        if (dirPathEl) dirPathEl.focus();
    },

    async requestPublishDraftWithRetry(article, { maxAttempts = PUBLISH_ATTEMPTS } = {}) {
        let lastError = null;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            try {
                const res = await fetch(`${API_BASE}/publish-draft`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ article }),
                });

                const raw = await res.text();
                let data = {};
                try {
                    data = raw ? JSON.parse(raw) : {};
                } catch {
                    data = { error: raw || `HTTP ${res.status}` };
                }

                if (!res.ok || data.error) {
                    const error = new Error(data.error || `Publish request failed (${res.status})`);
                    error.status = res.status;
                    error.retryable = Boolean(data.retryable);
                    error.code = data.code || '';
                    error.details = data.details || null;
                    throw error;
                }

                return { data, attempt };
            } catch (err) {
                lastError = err;
                if (!this.isRetryablePublishError(err) || attempt >= maxAttempts) {
                    err.attempt = attempt;
                    throw err;
                }
                await this.sleep(PUBLISH_RETRY_BASE_DELAY_MS * attempt);
            }
        }

        throw lastError || new Error('Publish failed');
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
        const controller = new AbortController();
        const timeoutHandle = setTimeout(() => controller.abort(), ARTICLE_REQUEST_TIMEOUT_MS);
        try {
            const response = await fetch(`${API_BASE}/write-article-safe`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cluster }),
                signal: controller.signal,
            });
            const payload = await response.json();
            if (!response.ok || !payload?.ok || payload?.error) {
                const message = payload?.error?.message || payload?.error || `HTTP ${response.status}`;
                const error = new Error(message);
                error.payload = payload;
                throw error;
            }
            return payload;
        } catch (err) {
            if (err?.name === 'AbortError') {
                throw new Error(`Generation timed out after ${Math.round(ARTICLE_REQUEST_TIMEOUT_MS / 60000)} minutes`);
            }
            throw err;
        } finally {
            clearTimeout(timeoutHandle);
        }
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
        this.state.generatedArticles = {};
        this.state.editorDrafts = {};
        this.state.previewingClusterId = null;
        document.getElementById('preview-container').innerHTML = '';
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

        document.getElementById('btn-publish-all').disabled = Object.keys(this.state.generatedArticles).length === 0;

        if (this.state.autoPublishAfterGeneration) {
            this.state.autoPublishAfterGeneration = false;
            if (!Object.keys(this.state.generatedArticles).length) {
                alert('Generation finished, but no articles were available to publish.');
                return;
            }
            await this.publishAll({ confirmFirst: false, fromGeneratePublish: true });
        }
    },

    async startGenerateAndPublish() {
        if (this.state.isPublishing) return;
        this.setLoading('btn-generate-publish-review', true);
        this.state.autoPublishAfterGeneration = true;
        try {
            await this.startGeneration();
        } catch (err) {
            this.state.autoPublishAfterGeneration = false;
            throw err;
        } finally {
            this.setLoading('btn-generate-publish-review', false);
        }
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
        const flair = post.predicted_flair || '';
        let url = `https://old.reddit.com/r/BCNEnglishSpeakers/submit?title=${encodeURIComponent(title)}&text=${encodeURIComponent(text)}&selftext=true`;
        if (flair) {
            url += `&flair=${encodeURIComponent(flair)}&flair_text=${encodeURIComponent(flair)}`;
        }
        return url;
    },

    buildXIntentUrl(post = {}) {
        const text = this.buildXText(post);
        return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
    },

    buildXSocialHtml(posts = []) {
        const rows = posts.map((post, idx) => {
            const text = this.buildXText(post);
            const intentUrl = this.buildXIntentUrl(post);
            const imageUrl = post.featured_image_url || '';
            const imageThumb = post.featured_image_thumb_url || imageUrl;
            const imageAlt = post.featured_image_alt || post.title || 'Featured image';
            const imagePanel = imageUrl
                ? `<div class="x-media-card">
              <img src="${this.escapeHtml(imageThumb)}" alt="${this.escapeHtml(imageAlt)}" loading="lazy" />
              <div class="actions">
                <a href="${this.escapeHtml(imageUrl)}" target="_blank">Open featured image</a>
                <button type="button" class="copy-image-url" data-image-url="${this.escapeHtml(imageUrl)}">Copy image URL</button>
              </div>
            </div>`
                : '<p class="muted">No featured image found for this post.</p>';

            return `<article class="item">
          <h2>${idx + 1}. ${this.escapeHtml(post.title || 'Untitled')}</h2>
          <pre>${this.escapeHtml(text)}</pre>
          ${imagePanel}
          <div class="actions"><a href="${this.escapeHtml(intentUrl)}" target="_blank">Open prefilled X post</a></div>
        </article>`;
        }).join('\n');

        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>X Social Export</title>
  <style>
    body{font-family:Arial,sans-serif;padding:24px;line-height:1.5;background:#f5f7fb;color:#18212b}
    .item{background:#fff;border:1px solid #dde5ee;border-radius:10px;padding:14px;margin-bottom:18px}
    pre{white-space:pre-wrap;background:#f5f7fb;padding:12px;border:1px solid #e4ebf3;border-radius:8px}
    .actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:8px}
    .actions a,.actions button{display:inline-block;border:0;background:#0b63ce;color:#fff;padding:8px 11px;border-radius:8px;text-decoration:none;cursor:pointer;font-weight:600}
    .actions button{background:#4c5a69}
    .x-media-card{margin-top:10px;background:#f9fbfd;border:1px solid #e4ebf3;border-radius:8px;padding:10px}
    .x-media-card img{max-width:320px;width:100%;height:auto;border-radius:8px;display:block}
    .muted{color:#5b6876;font-size:0.92rem}
  </style>
</head>
<body>
  <h1>X Social Export (${posts.length} posts)</h1>
  <p class="muted">X intent links cannot reliably pre-attach images. Open the featured image first, then attach it in composer.</p>
  ${rows}
  <script>
    document.addEventListener('click', async function (event) {
      var btn = event.target.closest('.copy-image-url');
      if (!btn) return;
      var url = String(btn.getAttribute('data-image-url') || '');
      if (!url) return;
      try {
        await navigator.clipboard.writeText(url);
        var original = btn.textContent;
        btn.textContent = 'Copied image URL';
        setTimeout(function () { btn.textContent = original; }, 1200);
      } catch (_err) {
        alert('Could not copy image URL. Please copy manually.');
      }
    });
  </script>
</body>
</html>`;
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
            ${post.featured_image_thumb_url ? `<img src="${this.escapeHtml(post.featured_image_thumb_url)}" alt="${this.escapeHtml(post.featured_image_alt || post.title || 'Featured image')}" style="max-width:220px;width:100%;height:auto;border-radius:8px;border:1px solid #dce3ea;margin-bottom:8px;">` : ''}
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

    buildWhatsappSocialHtml(posts = []) {
        const channelSeed = DEFAULT_WHATSAPP_CHANNELS.map(channel => ({
            id: channel.id,
            label: channel.label,
            url: channel.url,
            to: channel.to || '',
            mode: channel.mode || 'open_url',
        }));
        const normalizedPosts = posts.map((post, idx) => ({
            id: Number(post?.id) || idx + 1,
            index: idx + 1,
            title: post?.title || 'Untitled',
            body: this.buildWhatsappText(post),
        }));

        const embeddedChannels = JSON.stringify(channelSeed).replace(/</g, '\\u003c');
        const embeddedPosts = JSON.stringify(normalizedPosts).replace(/</g, '\\u003c');

        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>WhatsApp Posts - ${normalizedPosts.length} Articles</title>
  <style>
    :root { color-scheme: light; }
    body { font-family: Arial, sans-serif; margin: 0; background: #f3f5f8; color: #1f2933; }
    .wrap { max-width: 1040px; margin: 0 auto; padding: 24px; }
    h1 { margin: 0 0 16px; color: #0f8c4f; border-bottom: 3px solid #0f8c4f; padding-bottom: 10px; }
    .panel { background: #fff; border: 1px solid #dce3ea; border-radius: 10px; padding: 14px; margin-bottom: 14px; }
    .panel h2 { margin: 0 0 10px; font-size: 1.05rem; }
    .inline { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
    input[type="text"], input[type="url"] { border: 1px solid #c7d2de; border-radius: 8px; padding: 8px 10px; min-width: 220px; }
    select { border: 1px solid #c7d2de; border-radius: 8px; padding: 8px 10px; min-width: 180px; background: #fff; }
    .btn { border: 0; border-radius: 8px; padding: 9px 12px; font-weight: 600; cursor: pointer; }
    .btn-primary { background: #117a44; color: #fff; }
    .btn-secondary { background: #0b5f95; color: #fff; }
    .btn-neutral { background: #e9eef4; color: #223; }
    .btn-danger { background: #b62f2f; color: #fff; }
    .muted { color: #5b6876; font-size: 0.9rem; }
    .channel-list { margin-top: 10px; display: grid; gap: 8px; }
    .channel-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; background: #f8fafc; border: 1px solid #e3e9ef; border-radius: 8px; padding: 8px 10px; }
    .story { background: #fff; border: 1px solid #dce3ea; border-radius: 10px; padding: 16px; margin-bottom: 14px; }
    .story h3 { margin: 0 0 10px; }
    pre { white-space: pre-wrap; background: #f5f7fb; border: 1px solid #e6ebf1; border-radius: 8px; padding: 12px; }
    .story-channels { margin: 10px 0; display: grid; gap: 8px; }
    .story-channel { display: flex; align-items: center; gap: 8px; }
    .story-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
    .status { margin-top: 8px; font-size: 0.9rem; }
    .status.error { color: #b22929; }
    .status.ok { color: #117a44; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>WhatsApp Posts - ${normalizedPosts.length} Articles</h1>

    <div class="panel">
      <h2>Distribution channels</h2>
      <div class="inline">
        <input id="channel-label" type="text" placeholder="Channel label" />
        <input id="channel-url" type="url" placeholder="https://whatsapp.com/channel/..." />
        <input id="channel-to" type="text" placeholder="Provider destination (e.g. 1203...@g.us)" />
        <select id="channel-mode">
          <option value="open_url">Open URL + copy text</option>
          <option value="api">Send via API destination</option>
        </select>
        <button class="btn btn-primary" id="add-channel">Add channel</button>
      </div>
      <div class="inline" style="margin-top:10px;">
        <button class="btn btn-neutral" id="select-all-channels-all">Select all channels for all stories</button>
        <button class="btn btn-neutral" id="clear-all-channels-all">Clear all channels for all stories</button>
      </div>
      <div class="channel-list" id="channel-list"></div>
      <div class="muted">Channels are saved locally in this browser for future exports.</div>
    </div>

    <div class="panel">
      <h2>Bulk send</h2>
      <div class="inline">
        <button class="btn btn-secondary" id="send-selected-stories">Send selected stories</button>
      </div>
      <div class="muted">Only stories with the bulk checkbox enabled are included. Each story can target one or multiple channels.</div>
    </div>

    <div id="stories"></div>
  </div>

  <script>
    (function () {
      var STORAGE_KEY = 'whatsapp-export-channels-v1';
      var defaultChannels = ${embeddedChannels};
      var posts = ${embeddedPosts};
      var channels = loadChannels();

      function escapeHtml(value) {
        return String(value || '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      function normalizeId(label) {
        return String(label || 'channel')
          .toLowerCase()
          .trim()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/(^-|-$)/g, '') || ('channel-' + Date.now());
      }

      function normalizeMode(mode) {
        return mode === 'api' ? 'api' : 'open_url';
      }

      function isValidDestination(to) {
        return /^[\\d-]{9,31}(@[\\w.]{1,})?$/.test(String(to || '').trim());
      }

      function inferDefaultsByLabel(label) {
        var normalized = String(label || '').trim().toLowerCase();
        if (normalized === 'news-flash' || normalized === 'news flash') {
          return { to: '120363269876975950@g.us', mode: 'api' };
        }
        if (normalized === 'broadcast channel') {
          return { to: '0029Vb6PJDh6WaKjaAcWAX1h@newsletter', mode: 'open_url' };
        }
        return { to: '', mode: 'open_url' };
      }

      function isValidChannel(entry) {
        var mode = normalizeMode(entry && entry.mode);
        return entry
          && typeof entry.label === 'string'
          && entry.label.trim().length
          && typeof entry.url === 'string'
          && /^https?:\/\//i.test(entry.url.trim())
          && (mode !== 'api' || isValidDestination(entry.to));
      }

      function loadChannels() {
        try {
          var stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
          if (Array.isArray(stored)) {
            var parsed = stored.filter(isValidChannel).map(function (entry) {
              var inferred = inferDefaultsByLabel(entry.label);
              return {
                id: String(entry.id || normalizeId(entry.label)),
                label: entry.label.trim(),
                url: entry.url.trim(),
                to: String(entry.to || inferred.to || '').trim(),
                mode: normalizeMode(entry.mode || inferred.mode),
              };
            });
            if (parsed.length) return parsed;
          }
        } catch (_err) {}
        return defaultChannels.slice();
      }

      function saveChannels() {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(channels));
      }

      function getStorySelections() {
        var map = {};
        document.querySelectorAll('.story').forEach(function (storyEl) {
          var storyId = storyEl.getAttribute('data-story-id');
          var selectedChannels = new Set();
          storyEl.querySelectorAll('.story-channel-check:checked').forEach(function (cb) {
            selectedChannels.add(cb.value);
          });
          map[storyId] = {
            bulk: !!storyEl.querySelector('.story-bulk-toggle')?.checked,
            channels: selectedChannels,
          };
        });
        return map;
      }

      function setStatus(storyId, message, tone) {
        var el = document.getElementById('status-' + storyId);
        if (!el) return;
        el.textContent = message || '';
        el.className = 'status ' + (tone || '');
      }

      function renderChannelList() {
        var list = document.getElementById('channel-list');
        if (!list) return;
        if (!channels.length) {
          list.innerHTML = '<div class="muted">No channels configured yet.</div>';
          return;
        }
        var html = channels.map(function (channel) {
          var modeLabel = channel.mode === 'api' ? 'API send' : 'Open URL';
          var toLine = channel.to ? ('<span class="muted">to: ' + escapeHtml(channel.to) + '</span>') : '<span class="muted">No provider destination set</span>';
          return '<div class="channel-row">'
            + '<strong>' + escapeHtml(channel.label) + '</strong>'
            + '<a href="' + escapeHtml(channel.url) + '" target="_blank" rel="noopener">' + escapeHtml(channel.url) + '</a>'
            + '<span class="muted">mode: ' + escapeHtml(modeLabel) + '</span>'
            + toLine
            + '<button class="btn btn-danger remove-channel" data-channel-id="' + escapeHtml(channel.id) + '">Remove</button>'
            + '</div>';
        }).join('');
        list.innerHTML = html;
      }

      async function sendViaApi(channel, text) {
        if (typeof window.whatsappSendMessage === 'function') {
          return window.whatsappSendMessage({ to: channel.to, message: text, channel: channel });
        }
        return null;
      }

      function renderStories(prevSelections) {
        var container = document.getElementById('stories');
        if (!container) return;
        var html = posts.map(function (post) {
          var selected = prevSelections && prevSelections[String(post.id)] ? prevSelections[String(post.id)] : null;
          var channelRows = channels.map(function (channel) {
            var checked = selected ? selected.channels.has(channel.id) : true;
            return '<label class="story-channel">'
              + '<input type="checkbox" class="story-channel-check" value="' + escapeHtml(channel.id) + '" ' + (checked ? 'checked' : '') + '>'
              + '<span>' + escapeHtml(channel.label) + '</span>'
              + '</label>';
          }).join('');

          return '<article class="story" data-story-id="' + escapeHtml(post.id) + '">'
            + '<h3>' + escapeHtml(post.index + '. ' + post.title) + '</h3>'
            + '<pre id="story-text-' + escapeHtml(post.id) + '">' + escapeHtml(post.body) + '</pre>'
            + '<label class="story-channel"><input type="checkbox" class="story-bulk-toggle" ' + ((selected ? selected.bulk : true) ? 'checked' : '') + '> Include in bulk send</label>'
            + '<div class="story-channels">' + channelRows + '</div>'
            + '<div class="story-actions">'
            + '  <button class="btn btn-primary copy-story" data-story-id="' + escapeHtml(post.id) + '">Copy</button>'
            + '  <button class="btn btn-secondary send-story" data-story-id="' + escapeHtml(post.id) + '">Send to selected channels</button>'
            + '  <button class="btn btn-neutral select-story-channels" data-story-id="' + escapeHtml(post.id) + '">Select all channels</button>'
            + '  <button class="btn btn-neutral clear-story-channels" data-story-id="' + escapeHtml(post.id) + '">Clear channels</button>'
            + '</div>'
            + '<div class="status" id="status-' + escapeHtml(post.id) + '"></div>'
            + '</article>';
        }).join('');
        container.innerHTML = html;
      }

      function getSelectedChannelsForStory(storyId) {
        var storyEl = document.querySelector('.story[data-story-id="' + CSS.escape(String(storyId)) + '"]');
        if (!storyEl) return [];
        var selectedIds = Array.from(storyEl.querySelectorAll('.story-channel-check:checked')).map(function (cb) {
          return cb.value;
        });
        return channels.filter(function (channel) {
          return selectedIds.includes(channel.id);
        });
      }

      function getStoryText(storyId) {
        return document.getElementById('story-text-' + storyId)?.textContent || '';
      }

      async function copyStory(storyId) {
        var text = getStoryText(storyId);
        if (!text.trim()) return;
        await navigator.clipboard.writeText(text);
        setStatus(storyId, 'Copied to clipboard.', 'ok');
      }

      async function sendStory(storyId, opts) {
        var options = opts || {};
        var selectedChannels = getSelectedChannelsForStory(storyId);
        if (!selectedChannels.length) {
          setStatus(storyId, 'No channels selected for this story.', 'error');
          if (!options.silent) alert('No channels selected for this story.');
          return false;
        }

        var text = getStoryText(storyId);
        if (text.trim()) {
          try { await navigator.clipboard.writeText(text); } catch (_err) {}
        }

        var okCount = 0;
        var failCount = 0;
        for (var i = 0; i < selectedChannels.length; i += 1) {
          var channel = selectedChannels[i];
          try {
            if (channel.mode === 'api' && channel.to && isValidDestination(channel.to)) {
              var apiResult = await sendViaApi(channel, text);
              if (apiResult === null) {
                var fallbackPopup = window.open(channel.url, '_blank', 'noopener');
                if (!fallbackPopup) throw new Error('Popup blocked and API sender unavailable');
              }
            } else {
              var popup = window.open(channel.url, '_blank', 'noopener');
              if (!popup) throw new Error('Popup blocked');
            }
            okCount += 1;
          } catch (err) {
            failCount += 1;
          }
        }

        var note = '';
        if (okCount > 0 && failCount === 0) {
          note = 'Sent/opened ' + okCount + ' channel' + (okCount === 1 ? '' : 's') + '. Message copied to clipboard.';
          setStatus(storyId, note, 'ok');
        } else if (okCount > 0 && failCount > 0) {
          note = 'Processed ' + okCount + ' channel(s), ' + failCount + ' failed. Message copied to clipboard.';
          setStatus(storyId, note, 'error');
        } else {
          note = 'No channels processed successfully. Message copied to clipboard.';
          setStatus(storyId, note, 'error');
        }
        return true;
      }

      function setStoryChannelSelection(storyId, checked) {
        var storyEl = document.querySelector('.story[data-story-id="' + CSS.escape(String(storyId)) + '"]');
        if (!storyEl) return;
        storyEl.querySelectorAll('.story-channel-check').forEach(function (input) {
          input.checked = checked;
        });
        setStatus(storyId, '', '');
      }

      function setAllStoryChannels(checked) {
        document.querySelectorAll('.story .story-channel-check').forEach(function (input) {
          input.checked = checked;
        });
      }

      async function sendBulkStories() {
        var selectedStoryIds = Array.from(document.querySelectorAll('.story-bulk-toggle:checked')).map(function (toggle) {
          return toggle.closest('.story')?.getAttribute('data-story-id');
        }).filter(Boolean);

        if (!selectedStoryIds.length) {
          alert('No stories selected for bulk send.');
          return;
        }

        var sent = 0;
        var skipped = 0;
        for (var i = 0; i < selectedStoryIds.length; i += 1) {
          var ok = await sendStory(selectedStoryIds[i], { silent: true });
          if (ok) sent += 1;
          else skipped += 1;
        }

        if (skipped > 0) {
          alert('Bulk send complete: ' + sent + ' sent, ' + skipped + ' skipped (missing channels).');
        } else {
          alert('Bulk send complete: ' + sent + ' stories sent.');
        }
      }

      document.addEventListener('click', async function (event) {
        var addBtn = event.target.closest('#add-channel');
        if (addBtn) {
          var labelInput = document.getElementById('channel-label');
          var urlInput = document.getElementById('channel-url');
          var toInput = document.getElementById('channel-to');
          var modeInput = document.getElementById('channel-mode');
          var label = String(labelInput?.value || '').trim();
          var url = String(urlInput?.value || '').trim();
          var to = String(toInput?.value || '').trim();
          var mode = normalizeMode(modeInput?.value || 'open_url');
          if (!label || !/^https?:\/\//i.test(url)) {
            alert('Enter a channel label and a valid URL starting with http:// or https://');
            return;
          }
          if (mode === 'api' && !isValidDestination(to)) {
            alert('For API send mode, enter a valid destination like 1203...@g.us or 0029...@newsletter');
            return;
          }
          var idBase = normalizeId(label);
          var id = idBase;
          var suffix = 1;
          while (channels.some(function (channel) { return channel.id === id; })) {
            suffix += 1;
            id = idBase + '-' + suffix;
          }
          var prevSelections = getStorySelections();
          channels.push({ id: id, label: label, url: url, to: to, mode: mode });
          saveChannels();
          renderChannelList();
          renderStories(prevSelections);
          if (labelInput) labelInput.value = '';
          if (urlInput) urlInput.value = '';
          if (toInput) toInput.value = '';
          if (modeInput) modeInput.value = 'open_url';
          return;
        }

        var removeBtn = event.target.closest('.remove-channel');
        if (removeBtn) {
          var removeId = removeBtn.getAttribute('data-channel-id');
          var prev = getStorySelections();
          channels = channels.filter(function (channel) { return channel.id !== removeId; });
          saveChannels();
          renderChannelList();
          renderStories(prev);
          return;
        }

        var copyBtn = event.target.closest('.copy-story');
        if (copyBtn) {
          var copyId = copyBtn.getAttribute('data-story-id');
          try {
            await copyStory(copyId);
          } catch (_err) {
            setStatus(copyId, 'Could not copy. Please copy manually.', 'error');
          }
          return;
        }

        var sendBtn = event.target.closest('.send-story');
        if (sendBtn) {
          var sendId = sendBtn.getAttribute('data-story-id');
          await sendStory(sendId, { silent: false });
          return;
        }

        var selectBtn = event.target.closest('.select-story-channels');
        if (selectBtn) {
          setStoryChannelSelection(selectBtn.getAttribute('data-story-id'), true);
          return;
        }

        var clearBtn = event.target.closest('.clear-story-channels');
        if (clearBtn) {
          setStoryChannelSelection(clearBtn.getAttribute('data-story-id'), false);
          return;
        }

        if (event.target.closest('#select-all-channels-all')) {
          setAllStoryChannels(true);
          return;
        }

        if (event.target.closest('#clear-all-channels-all')) {
          setAllStoryChannels(false);
          return;
        }

        if (event.target.closest('#send-selected-stories')) {
          await sendBulkStories();
        }
      });

      renderChannelList();
      renderStories();
    })();
  </script>
</body>
</html>`;
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
            renderActions: (post) => {
                const flair = post.predicted_flair || '';
                const flairBadge = flair
                    ? `<span style="display:inline-block;background:#eef;padding:3px 8px;border-radius:4px;font-size:0.85rem;margin-right:8px;"><strong>Flair:</strong> ${this.escapeHtml(flair)}</span>`
                    : `<span style="display:inline-block;background:#fff3cd;padding:3px 8px;border-radius:4px;font-size:0.85rem;margin-right:8px;">⚠ No flair mapped — select manually</span>`;
                return `<div class="actions">${flairBadge}<a href="${this.buildRedditSubmitUrl(post)}" target="_blank">Open prefilled Reddit post</a></div>`;
            },
        });
        const xHtml = this.buildXSocialHtml(selected);
        const whatsappHtml = this.buildWhatsappSocialHtml(selected);

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
    async publishAll({ confirmFirst = true, articlesOverride = null, fromGeneratePublish = false, retryOnly = false } = {}) {
        if (this.state.isPublishing) return;
        const articles = Array.isArray(articlesOverride) ? articlesOverride : Object.values(this.state.generatedArticles);
        if (!articles.length) {
            alert('No generated articles available to publish.');
            return;
        }
        if (confirmFirst && !confirm('This will create DRAFT posts in WordPress. Continue?')) return;

        this.state.isPublishing = true;
        this.setLoading('btn-publish-all', true);
        this.setLoading('btn-generate-publish', true);
        this.setLoading('btn-generate-publish-review', true);
        this.resetPublishState(articles.length);
        this.updatePublishProgress(retryOnly ? 'Retrying failed publishes...' : 'Starting publish...');
        this.setPipelineStage('Publishing drafts to WordPress...', 92);
        this.logEvent('info', 'publish', 'Publish flow started', { total: articles.length, retryOnly, fromGeneratePublish });

        for (const article of articles) {
            const startedAt = Date.now();
            try {
                this.updatePublishProgress(`Publishing ${article.title}...`);
                const { data, attempt } = await this.requestPublishDraftWithRetry(article);
                this.mergeUsageDelta(data.usage || {});
                this.state.publishSuccess += 1;

                const statusDiv = document.getElementById(`proc-${article.cluster_id}`);
                if (statusDiv) {
                    statusDiv.className = 'status-bar success';
                    statusDiv.innerHTML = `<span>🚀 Published Draft: <a href="${data.result.editLink}" target="_blank" style="color:inherit; text-decoration:underline;">Edit in WordPress</a></span>`;
                }

                this.logEvent('info', 'publish', 'Draft published', {
                    clusterId: article.cluster_id,
                    editLink: data.result.editLink,
                    usage: data.usage || {},
                    attempt,
                });
            } catch (err) {
                this.state.publishFailed += 1;
                const failure = {
                    clusterId: article.cluster_id,
                    title: article.title,
                    article,
                    reason: err.message,
                    code: err.code || '',
                    details: err.details || null,
                    retryable: this.isRetryablePublishError(err),
                    status: Number(err?.status || 0),
                    attempts: Number(err?.attempt || PUBLISH_ATTEMPTS),
                };
                this.state.publishFailures = this.state.publishFailures.filter(item => item.clusterId !== article.cluster_id);
                this.state.publishFailures.push(failure);

                const statusDiv = document.getElementById(`proc-${article.cluster_id}`);
                if (statusDiv) {
                    statusDiv.className = 'status-bar error';
                    const detailLine = failure.details
                        ? ` [${this.escapeHtml(JSON.stringify(failure.details))}]`
                        : '';
                    statusDiv.innerHTML = `<span>❌ Publish failed: ${this.escapeHtml(article.title)} (${this.escapeHtml(err.message)}${detailLine})</span>`;
                }

                this.logEvent('error', 'publish', 'Draft publish failed', {
                    clusterId: article.cluster_id,
                    error: err.message,
                    retryable: failure.retryable,
                    status: failure.status,
                });
            } finally {
                this.state.publishCompleted += 1;
                this.state.publishDurationsMs.push(Date.now() - startedAt);
                this.updatePublishProgress(retryOnly ? 'Retrying failed publishes...' : 'Publishing drafts...');
            }
        }

        this.state.isPublishing = false;
        this.setLoading('btn-publish-all', false);
        this.setLoading('btn-generate-publish', false);
        this.setLoading('btn-generate-publish-review', false);
        document.getElementById('btn-open-social').disabled = false;
        const retryBtn = document.getElementById('btn-retry-failed-publish');
        if (retryBtn) retryBtn.disabled = this.state.publishFailures.length === 0;

        if (this.state.publishFailed > 0) {
            this.updatePublishProgress('Publish finished with failures');
            this.setPipelineStage('Publishing finished with failures. Retry failed drafts.', 96);
            alert(`Publishing finished: ${this.state.publishSuccess} succeeded, ${this.state.publishFailed} failed.`);
        } else {
            this.updatePublishProgress('Publish complete');
            this.setPipelineStage('Workflow complete.', 100);
        }

        this.logEvent('info', 'publish', 'Publish flow complete', {
            published: this.state.publishSuccess,
            failed: this.state.publishFailed,
            total: this.state.publishTotal,
        });
    },

    async retryFailedPublishes() {
        if (this.state.isPublishing) return;
        const retryableFailures = this.state.publishFailures.filter(item => item.retryable !== false && item.article);
        if (!retryableFailures.length) {
            alert('No retryable failed publishes available.');
            return;
        }
        const articles = retryableFailures.map(item => item.article);
        await this.publishAll({
            confirmFirst: false,
            articlesOverride: articles,
            retryOnly: true,
        });
    }
};

document.addEventListener('DOMContentLoaded', () => app.init());
