const API_BASE = '/api';

const app = {
    state: {
        currentStep: 1,
        directoryPath: '',
        articles: [],
        clusters: [],
        selectedClusterIds: new Set(),
        generatedArticles: {}, // clusterId -> article
        editorDrafts: {}, // clusterId -> editable article draft
        previewingClusterId: null,
        editorMode: 'visual',
        generationTimerInterval: null,
        generationStartedAt: null,
        generationTotal: 0,
        generationCompleted: 0,
    },

    init() {
        this.bindEvents();
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

        document.getElementById('btn-confirm-clusters').addEventListener('click', () => this.goToStep(3));
        document.getElementById('btn-start-writing').addEventListener('click', () => this.startGeneration());
        document.getElementById('btn-publish-all').addEventListener('click', () => this.publishAll());

        const btnSelectAllClusters = document.getElementById('btn-select-all-clusters');
        const btnSelectNoneClusters = document.getElementById('btn-select-none-clusters');
        const btnSelectAllHeadlines = document.getElementById('btn-select-all-headlines');
        const btnSelectNoneHeadlines = document.getElementById('btn-select-none-headlines');

        if (btnSelectAllClusters) {
            btnSelectAllClusters.addEventListener('click', () => this.setClusterSelection(true));
        }
        if (btnSelectNoneClusters) {
            btnSelectNoneClusters.addEventListener('click', () => this.setClusterSelection(false));
        }
        if (btnSelectAllHeadlines) {
            btnSelectAllHeadlines.addEventListener('click', () => this.setHeadlineSelection(true));
        }
        if (btnSelectNoneHeadlines) {
            btnSelectNoneHeadlines.addEventListener('click', () => this.setHeadlineSelection(false));
        }
    },

    setClusterSelection(checked) {
        document.querySelectorAll('.cluster-card .checkbox').forEach(cb => {
            cb.checked = checked;
        });
    },

    setHeadlineSelection(checked) {
        document.querySelectorAll('.publish-check').forEach(cb => {
            cb.checked = checked;
        });
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
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;

        if (progressEl) progressEl.style.width = `${pct}%`;
        if (labelEl) {
            const suffix = total > 0 ? `(${done}/${total})` : '';
            labelEl.innerText = label ? `${label} ${suffix}`.trim() : suffix;
        }
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

        if (step === 3) {
            this.renderHeadlinesSelection();
        }
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

        // Proceed to clustering immediately
        await this.clusterStories();
    },

    // ─── Step 2: Cluster Stories ─────────────────────────────────────
    async clusterStories() {
        console.log('Starting story clustering for', this.state.articles.length, 'articles...');
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

            this.setLoading('btn-load-dir', false);
            this.goToStep(2);

        } catch (err) {
            console.error('Clustering failed:', err);
            alert(`Clustering failed: ${err.message}`);
            this.setLoading('btn-load-dir', false);
        }
    },

    renderClusters() {
        const container = document.getElementById('clusters-container');
        container.innerHTML = '';

        this.state.clusters.forEach(cluster => {
            const isDuplicate = cluster.duplicate;
            const el = document.createElement('div');
            el.className = `card cluster-card ${isDuplicate ? 'duplicate' : ''}`;

            const sourcesHtml = cluster.sources.map(s =>
                `<div>• <a href="${s.url}" target="_blank">${s.name}</a>: ${s.title}</div>`
            ).join('');

            el.innerHTML = `
        <input type="checkbox" class="checkbox" 
          data-id="${cluster.cluster_id}" 
          ${!isDuplicate ? 'checked' : ''}>
        
        <div class="cluster-details">
          <div class="cluster-meta">
            ${isDuplicate ? '<span class="badge badge-duplicate">Existing Coverage</span>' : '<span class="badge badge-new">New Story</span>'}
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
    },

    // ─── Step 3: Select Headlines ────────────────────────────────────
    renderHeadlinesSelection() {
        // Update selected IDs from step 2
        this.state.selectedClusterIds.clear();
        document.querySelectorAll('.cluster-card .checkbox:checked').forEach(cb => {
            this.state.selectedClusterIds.add(parseInt(cb.dataset.id));
        });

        const container = document.getElementById('headlines-container');
        container.innerHTML = '';

        // Filter only selected clusters
        const selectedClusters = this.state.clusters.filter(c =>
            this.state.selectedClusterIds.has(c.cluster_id)
        );

        if (selectedClusters.length === 0) {
            container.innerHTML = '<p>No stories selected.</p>';
            return;
        }

        selectedClusters.forEach(c => {
            const el = document.createElement('div');
            el.className = 'card';
            el.innerHTML = `
        <div style="display:flex; gap:1rem; align-items:center;">
          <input type="checkbox" checked class="checkbox publish-check" data-id="${c.cluster_id}" style="width:20px; height:20px;">
          <div>
            <h4 style="margin:0;">${c.headline}</h4>
            <p style="margin:0; font-size:0.9rem;">${c.summary}</p>
          </div>
        </div>
      `;
            container.appendChild(el);
        });
    },

    // ─── Step 4: Generation ──────────────────────────────────────────
    async startGeneration() {
        // Get final selection
        const toProcessIds = new Set();
        document.querySelectorAll('.publish-check:checked').forEach(cb => {
            toProcessIds.add(parseInt(cb.dataset.id));
        });

        if (toProcessIds.size === 0) return alert('No stories selected for writing.');

        this.goToStep(4);
        const progressEl = document.getElementById('generation-progress');
        progressEl.innerHTML = '';

        const clustersToProcess = this.state.clusters.filter(c => toProcessIds.has(c.cluster_id));
        this.state.generationTotal = clustersToProcess.length;
        this.state.generationCompleted = 0;
        this.startGenerationTimer();
        this.updateGenerationProgress('Starting generation...');

        // Create placeholders
        clustersToProcess.forEach(c => {
            const div = document.createElement('div');
            div.id = `proc-${c.cluster_id}`;
            div.className = 'status-bar';
            div.innerHTML = `<span>Writing: ${c.headline}...</span> <div class="spinner"></div>`;
            progressEl.appendChild(div);
        });

        // Process sequentially (could be parallel but safer sequential for API limits)
        for (const cluster of clustersToProcess) {
            try {
                const res = await fetch(`${API_BASE}/write-article`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ cluster })
                });
                const data = await res.json();

                if (data.error) throw new Error(data.error);

                this.state.generatedArticles[cluster.cluster_id] = data.article;

                // Update status
                const statusDiv = document.getElementById(`proc-${cluster.cluster_id}`);
                statusDiv.className = 'status-bar success';
                statusDiv.innerHTML = `
          <span>✅ Ready: <strong>${data.article.title}</strong></span>
          <button class="btn-secondary" style="padding:0.25rem 0.5rem; font-size:0.8rem;" onclick="app.previewArticle(${cluster.cluster_id})">Preview</button>
        `;

                // Load preview for first one
                if (Object.keys(this.state.generatedArticles).length === 1) {
                    this.previewArticle(cluster.cluster_id);
                }

            } catch (err) {
                const statusDiv = document.getElementById(`proc-${cluster.cluster_id}`);
                statusDiv.className = 'status-bar error';
                statusDiv.innerHTML = `<span>❌ Failed: ${cluster.headline} (${err.message})</span>`;
            } finally {
                this.state.generationCompleted += 1;
                this.updateGenerationProgress('Generating articles...');
            }
        }

        this.stopGenerationTimer();
        this.updateGenerationProgress('Generation complete');

        document.getElementById('btn-publish-all').disabled = false;
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

        const onMetaChange = () => {
            draft.title = titleInput.value;
            draft.meta_description = metaInput.value;
            this.markEditorSaved('Saving...');
            this.autosaveDraft(clusterId);
        };

        const onVisualChange = () => {
            draft.body_html = visualBody.innerHTML;
            htmlBody.value = draft.body_html;
            this.markEditorSaved('Saving...');
            this.autosaveDraft(clusterId);
        };

        const onHtmlChange = () => {
            draft.body_html = htmlBody.value;
            visualBody.innerHTML = draft.body_html;
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

    // ─── Step 5: Publish ─────────────────────────────────────────────
    async publishAll() {
        if (!confirm('This will create DRAFT posts in WordPress. Continue?')) return;

        this.setLoading('btn-publish-all', true);
        const articles = Object.values(this.state.generatedArticles);

        for (const article of articles) {
            try {
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

                // Mark as published in UI
                const statusDiv = document.getElementById(`proc-${article.cluster_id}`);
                statusDiv.innerHTML = `
          <span>🚀 Published Draft: <a href="${data.result.editLink}" target="_blank" style="color:inherit; text-decoration:underline;">Edit in WordPress</a></span>
        `;

            } catch (err) {
                alert(`Publish failed for "${article.title}": ${err.message}`);
            }
        }

        this.setLoading('btn-publish-all', false);
        document.getElementById('btn-publish-all').innerText = 'All Done!';
    }
};

document.addEventListener('DOMContentLoaded', () => app.init());
