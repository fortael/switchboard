<template>
  <div class="lp-root">

    <!-- ── HERO ───────────────────────────────────────────────── -->
    <header class="lp-hero">
      <div class="lp-hero-inner">
        <img class="lp-logo" :src="iconUrl" alt="Wooton Pad icon" width="72" height="72">
        <h1 class="lp-title">Wooton Pad</h1>
        <p class="lp-tagline">The session manager for Claude Code</p>
        <div class="lp-cta">
          <a class="lp-btn-primary" href="https://github.com/fortael/wootonpad/releases" target="_blank" rel="noopener">
            Download
          </a>
          <a class="lp-btn-secondary" href="https://github.com/fortael/wootonpad" target="_blank" rel="noopener">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>
            GitHub
            <span v-if="stars !== null" class="lp-stars">★ {{ stars }}</span>
          </a>
        </div>
        <div class="lp-platforms">
          <span>macOS</span><span>·</span><span>Linux</span><span>·</span><span>Windows</span>
        </div>
      </div>
    </header>

    <!-- ── INTERACTIVE DEMO ──────────────────────────────────── -->
    <section class="lp-demo-section">
      <div class="lp-section-inner">
        <h2 class="lp-section-title">Try the real interface</h2>

        <!-- The demo below renders the app's own components (TopNavApp,
             CommandBar, AttentionRail, FilterTabs, SidebarApp,
             SessionHeaderApp …) inside App.vue's wrapper markup, driven by
             mock-data.js. Change a component in src/vue/components and this
             picks it up with no edit here. -->
        <div class="lp-app-window" :data-theme="store.theme">
          <!-- macOS-style title bar -->
          <div class="lp-titlebar">
            <div class="lp-traffic-lights">
              <span class="lp-tl lp-tl-close"></span>
              <span class="lp-tl lp-tl-min"></span>
              <span class="lp-tl lp-tl-max"></span>
            </div>
            <span class="lp-titlebar-name">Wooton Pad</span>
          </div>

          <!-- ── App shell — mirrors src/vue/components/App.vue ──────── -->
          <div class="sbx-shell">
            <TopNavApp
              :tabs="store.sidebarCollapsed ? [] : TABS"
              :active-id="store.activeTab"
              :theme="store.theme"
              :sidebar-collapsed="store.sidebarCollapsed"
              @select="setTab"
              @settings="onGlobalSettings"
              @toggle-sidebar="store.sidebarCollapsed = !store.sidebarCollapsed"
              @toggle-theme="toggleTheme"
            >
              <template #account>
                <AccountDropdownApp ref="accountDropdownRef" :callbacks="accountDropdownCallbacks" />
              </template>
            </TopNavApp>

            <div class="sbx-shell__body">
              <CollapsedRailApp
                v-if="store.sidebarCollapsed"
                :tabs="TABS"
                :active-id="store.activeTab"
                :projects="attentionProjects"
                :active-project="store.attentionProject"
                @select="setTab"
                @select-project="onSelectAttentionProject"
                @settings="onGlobalSettings"
                @expand="store.sidebarCollapsed = false"
              />

              <div id="sidebar" v-show="!store.sidebarCollapsed">
                <CommandBar
                  :model-value="store.searchQuery"
                  :placeholder="searchPlaceholder"
                  add-title="Add project"
                  @update:model-value="onSearchValue"
                  @add="onAddProject"
                  @spotlight="focusSearch"
                >
                  <template #field-actions>
                    <button
                      v-show="store.searchQuery"
                      type="button"
                      class="sbx-commandbar__chip"
                      aria-label="Clear search"
                      @click="doClearSearch"
                    >&times;</button>
                    <button
                      type="button"
                      class="sbx-commandbar__chip"
                      :class="{ 'is-active': store.searchTitlesOnly }"
                      data-tooltip="Search titles only"
                      aria-label="Search titles only"
                      @click="toggleTitlesOnly"
                    >Tt</button>
                  </template>
                </CommandBar>

                <AttentionRail
                  v-if="store.activeTab === 'sessions'"
                  :items="attentionProjects"
                  :active-name="attentionActiveName"
                  @select="onSelectAttentionName"
                />

                <FilterTabs
                  v-if="store.activeTab === 'sessions'"
                  :tabs="FILTER_TABS"
                  :active="store.sessionFilterTab"
                  :view-mode="store.sidebarViewMode"
                  @select="onFilterTab"
                  @update:view-mode="onViewMode"
                >
                  <template #actions>
                    <span id="loading-status" v-show="store.loadingStatus">{{ store.loadingStatus }}</span>
                    <button
                      type="button"
                      class="sbx-filtertabs__view"
                      data-tooltip="Re-sort sessions"
                      aria-label="Re-sort sessions"
                      @click="onResort"
                    >
                      <SbIcon name="refresh-cw" :size="13" tone="muted" />
                    </button>
                  </template>
                </FilterTabs>

                <div id="sidebar-content" v-show="store.activeTab === 'sessions'">
                  <SidebarApp :callbacks="sidebarCallbacks" />
                </div>
                <div id="plans-content" v-show="store.activeTab === 'plans'">
                  <PlansApp ref="plansRef" :callbacks="planCallbacks" />
                </div>
                <div id="stats-content" v-show="store.activeTab === 'stats'" class="lp-demo-empty-tab">
                  <div class="plans-empty">The activity heatmap needs a local Claude install — grab the app to see it.</div>
                </div>
                <div id="memory-content" v-show="store.activeTab === 'memory'">
                  <MemoryApp ref="memoryRef" :callbacks="memoryCallbacks" />
                </div>
                <div id="accounts-content" v-show="store.activeTab === 'accounts'">
                  <AccountsApp ref="accountsRef" :callbacks="accountsCallbacks" />
                </div>
                <div id="projects-content" v-show="store.activeTab === 'projects'">
                  <ProjectsApp ref="projectsRef" :callbacks="projectsCallbacks" />
                </div>
              </div>

              <div id="sidebar-resize-handle" v-show="!store.sidebarCollapsed"></div>

              <div id="main">
                <div id="vue-session-header">
                  <SessionHeaderApp />
                </div>

                <!-- No PTY on a landing page: a static transcript rendered
                     from mock-data.js, not an xterm instance. -->
                <div v-if="activeSession" class="lp-term">
                  <template v-for="(line, i) in terminalLines" :key="i">
                    <div v-if="line.t === 'logo'" class="lp-term-logo-block">
                      <div v-for="(art, ri) in line.logo" :key="ri" class="lp-term-line lp-term-logo-row">
                        <span class="lp-term-logo-art">{{ art }}</span>
                        <span class="lp-term-logo-meta" :class="'lp-logo-meta-' + ri">{{ line.info[ri] }}</span>
                      </div>
                    </div>
                    <div v-else-if="line.t === 'blank'" class="lp-term-blank"></div>
                    <div v-else-if="line.t === 'opt-sel'" class="lp-term-line lp-term-opt-sel">
                      <span class="lp-opt-cursor">❯</span>{{ line.v }}
                    </div>
                    <div v-else-if="line.t === 'sh-prompt'" class="lp-term-line lp-term-sh-prompt">
                      <span class="lp-sh-cwd">{{ line.cwd }}</span>
                      <span v-if="line.branch" class="lp-sh-branch">&nbsp;on <span class="lp-sh-branch-name">{{ line.branch }}</span></span>
                    </div>
                    <div v-else-if="line.t === 'sh-cmd'" class="lp-term-line lp-term-sh-cmd">
                      <span class="lp-sh-arrow">❯</span> {{ line.v }}
                    </div>
                    <div v-else-if="line.t === 'sh-cursor'" class="lp-term-line lp-term-sh-cmd">
                      <span class="lp-sh-arrow">❯</span> <span class="lp-sh-block-cursor">█</span>
                    </div>
                    <div v-else-if="line.t === 'spin'" class="lp-term-line lp-term-spin">
                      <span class="lp-spinner-char">{{ spinChar }}</span> {{ line.v }}
                    </div>
                    <div v-else-if="line.t === 'wait'" class="lp-term-line lp-term-wait">
                      <span class="lp-wait-cursor">▋</span> {{ line.v }}
                    </div>
                    <div v-else class="lp-term-line" :class="'lp-term-' + line.t">{{ line.v }}</div>
                  </template>
                </div>

                <div v-else class="lp-demo-placeholder">Select a session from the sidebar to begin.</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- ── FEATURES (BENTO) ─────────────────────────────────── -->
    <section class="lp-features">
      <div class="lp-section-inner">
        <h2 class="lp-section-title">Everything Claude Code needs</h2>
        <p class="lp-section-subtitle">One window for every session, project, and tool — so you stay focused on shipping.</p>

        <div class="lp-bento">

          <!-- Session browser — wide -->
          <div class="lp-bento-card lp-bento-wide lp-bento-accent-orange">
            <div class="lp-bento-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
            </div>
            <h3>Session Browser &amp; Full-Text Search</h3>
            <p>Every Claude conversation organised by project and indexed for full-text search. Find any session by what was discussed — not just when it happened.</p>
            <div class="lp-bento-pill">SQLite FTS5</div>
          </div>

          <!-- Multi-account -->
          <div class="lp-bento-card lp-bento-accent-blue">
            <div class="lp-bento-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="6" r="3.5"/><path d="M1.5 21c0-4 2.9-7 6.5-7s6.5 3 6.5 7"/><circle cx="17" cy="8.5" r="2.5"/><path d="M14.5 21c0-2.8 1.8-5 4.5-5s4.5 2.2 4.5 5"/></svg>
            </div>
            <h3>Multi-Account</h3>
            <p>Switch between personal and work accounts in one click. Separate credentials, histories, and usage quotas — no re-login.</p>
          </div>

          <!-- IDE diff viewer -->
          <div class="lp-bento-card lp-bento-accent-purple">
            <div class="lp-bento-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/></svg>
            </div>
            <h3>IDE Diff Viewer</h3>
            <p>Review every file change before it's applied. Accept, reject, or edit individual hunks with syntax highlighting.</p>
          </div>

          <!-- Git integration -->
          <div class="lp-bento-card lp-bento-accent-green">
            <div class="lp-bento-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M11 18H8a2 2 0 0 1-2-2V9"/><path d="M9 3 6 6l3 3"/></svg>
            </div>
            <h3>Git Integration</h3>
            <p>Branch, added/deleted lines, unpushed commits, and one-click branch switching in the project panel.</p>
          </div>

          <!-- Docker -->
          <div class="lp-bento-card lp-bento-accent-cyan">
            <div class="lp-bento-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12.5c0 .5-.1 1-.2 1.5H2.2A10 10 0 0 1 12 2a10 10 0 0 1 10 10.5z"/><path d="M2.2 14C3.2 18.5 7.2 22 12 22a10 10 0 0 0 9.8-8H2.2z"/><rect x="5" y="9" width="2" height="3" rx=".5"/><rect x="9" y="9" width="2" height="3" rx=".5"/><rect x="13" y="9" width="2" height="3" rx=".5"/></svg>
            </div>
            <h3>Docker Monitoring</h3>
            <p>Container status per project at a glance — know if your stack is running before handing off to Claude.</p>
          </div>

          <!-- AI commit — wide -->
          <div class="lp-bento-card lp-bento-wide lp-bento-accent-pink">
            <div class="lp-bento-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
            </div>
            <h3>AI Commit Messages</h3>
            <p>Generate short, detailed, or conventional-commit messages with Claude from the project panel. One click, no context switching.</p>
            <div class="lp-bento-pill">short · detailed · conventional</div>
          </div>

          <!-- Plans & Memory -->
          <div class="lp-bento-card lp-bento-accent-yellow">
            <div class="lp-bento-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/></svg>
            </div>
            <h3>Plans &amp; Memory</h3>
            <p>Browse and edit Claude's planning files and CLAUDE.md memory directly in the app.</p>
          </div>

          <!-- GitLab + avatars -->
          <div class="lp-bento-card lp-bento-accent-pink">
            <div class="lp-bento-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="m22.65 14.39-9.217 6.519a.5.5 0 0 1-.566 0L3.65 14.39a.5.5 0 0 1-.18-.557l1.28-3.943 2.396-7.373a.246.246 0 0 1 .468 0l2.397 7.373h6.782l2.397-7.373a.246.246 0 0 1 .468 0l2.395 7.372 1.28 3.944a.5.5 0 0 1-.177.556z"/></svg>
            </div>
            <h3>GitLab &amp; Avatars</h3>
            <p>Connect a GitLab token to pull project avatars automatically. Falls back to generated initials.</p>
          </div>

          <!-- File tree -->
          <div class="lp-bento-card lp-bento-accent-blue">
            <div class="lp-bento-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/><path d="M2 10h20"/></svg>
            </div>
            <h3>File Tree</h3>
            <p>Browse the project directory and open any file in the viewer panel without leaving the app.</p>
          </div>

          <!-- Activity stats — wide -->
          <div class="lp-bento-card lp-bento-wide lp-bento-accent-orange">
            <div class="lp-bento-icon">
              <svg width="24" height="24" viewBox="0 0 512 512" fill="currentColor"><path d="M128 496H48V304h80zm224 0h-80V208h80zm112 0h-80V96h80zm-224 0h-80V16h80z"/></svg>
            </div>
            <h3>Activity Stats &amp; Usage Tracking</h3>
            <p>GitHub-style heatmap of your coding activity across all projects. Token consumption and cost tracked per account, refreshed on demand.</p>
          </div>

          <!-- External launcher -->
          <div class="lp-bento-card lp-bento-accent-purple">
            <div class="lp-bento-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            </div>
            <h3>External Launcher</h3>
            <p><code>open wootonpad://+/path</code> opens or resumes sessions from any tool — no extra windows.</p>
          </div>

          <!-- Custom fonts -->
          <div class="lp-bento-card lp-bento-accent-green">
            <div class="lp-bento-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>
            </div>
            <h3>Custom Fonts</h3>
            <p>Configure terminal and UI fonts in Global Settings to match your editor setup.</p>
          </div>

        </div>
      </div>
    </section>

    <!-- ── PROJECT VIEWER DEMO ──────────────────────────────────── -->
    <section class="lp-project-demo-section">
      <div class="lp-section-inner">
        <div class="lp-project-demo-text">
          <h2 class="lp-section-title" style="margin:0 0 16px;">Your IDE is optional</h2>
          <p class="lp-project-demo-desc">Review changes, edit files, and commit — right inside Wooton Pad. Complex analysis no longer needs an editor open; Claude handles it all via CLI.</p>
        </div>

        <div class="lp-app-window lp-project-window">
          <div class="lp-titlebar">
            <div class="lp-traffic-lights">
              <span class="lp-tl lp-tl-close"></span>
              <span class="lp-tl lp-tl-min"></span>
              <span class="lp-tl lp-tl-max"></span>
            </div>
            <span class="lp-titlebar-name">Wooton Pad — my-api</span>
          </div>
          <div class="lp-project-body">
            <ProjectViewerApp ref="projectViewerRef" :callbacks="projectViewerCallbacks" />
          </div>
        </div>
      </div>
    </section>

    <!-- ── INSTALL ────────────────────────────────────────────── -->
    <section class="lp-install">
      <div class="lp-section-inner">
        <h2 class="lp-section-title">Get started</h2>
        <div class="lp-install-grid">
          <div class="lp-install-card">
            <div class="lp-install-platform">
              <svg width="20" height="20" viewBox="0 0 814 1000" fill="currentColor"><path d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.5-164-39.5c-76 0-103.7 40.8-165.9 40.8s-105-36.8-162.1-124.3C46.7 740.3 0 599.1 0 517.8c0-220.1 144.4-336.6 284.1-336.6 75.2 0 137.7 49.3 184.8 49.3 44.9 0 115.1-52.3 200.4-52.3zM518.3 15.3c28.5-35.3 50-84.2 50-133.1 0-6.7-.6-13.3-1.9-19.3-47.7 1.9-104.8 31.9-138.8 71.5-26.2 30.3-52.2 79.2-52.2 128.7 0 7.4 1.3 14.7 1.9 17.1 3.2.5 8.4 1.3 13.6 1.3 43.5 0 98.9-28.9 127.4-66.2z"/></svg>
              macOS
            </div>
            <a class="lp-dl-btn" href="https://github.com/fortael/wootonpad/releases" target="_blank" rel="noopener">Download .dmg</a>
            <p class="lp-install-note">arm64 + x64 universal</p>
          </div>
          <div class="lp-install-card">
            <div class="lp-install-platform">
              <svg width="20" height="20" viewBox="0 0 88 88" fill="currentColor"><path d="M0 0h42v42H0V0zm4 4h34v34H4V4zm42-4h42v42H46V0zm4 4h34v34H50V4zM0 46h42v42H0V46zm4 4h34v34H4V50zm42-4h42v42H46V46zm4 4h34v34H50V50z"/></svg>
              Windows
            </div>
            <a class="lp-dl-btn" href="https://github.com/fortael/wootonpad/releases" target="_blank" rel="noopener">Download .exe</a>
            <p class="lp-install-note">NSIS installer</p>
          </div>
          <div class="lp-install-card">
            <div class="lp-install-platform">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M20.581 19.049c-.55-.446-.336-1.431-.907-1.917.553-3.365-.997-6.331-2.845-8.232a9.286 9.286 0 0 0-6.636-2.736 9.65 9.65 0 0 0-2.108.234C4.924 7.086 2 10.006 2 13.5c0 3.866 3.134 7 7 7 .295 0 .585-.019.87-.055 1.5.35 3.17.55 4.13.65.96.101 3.001.51 4.001-.24 0 0 .5-.5 1-.5s1 .5 1.5.5 1-.5 1.5-.5.5.5.5.5c0 0-.97-1.857-.92-1.806zM9 19.5c-3.309 0-6-2.691-6-6s2.691-6 6-6 6 2.691 6 6-2.691 6-6 6z"/></svg>
              Linux
            </div>
            <a class="lp-dl-btn" href="https://github.com/fortael/wootonpad/releases" target="_blank" rel="noopener">Download .AppImage</a>
            <p class="lp-install-note">AppImage + .deb</p>
          </div>
        </div>
        <p class="lp-install-prereq">Requires <a href="https://docs.anthropic.com/en/docs/claude-code/getting-started" target="_blank" rel="noopener">Claude Code CLI</a> to be installed.</p>
      </div>
    </section>

    <!-- Tooltip element (matches public/style.css #app-tooltip) -->
    <div id="app-tooltip"></div>

    <!-- ── FOOTER ─────────────────────────────────────────────── -->
    <footer class="lp-footer">
      <div class="lp-footer-inner">
        <span>Wooton Pad · Open source · MIT license · Fork of Switchboard</span>
        <a href="https://github.com/fortael/wootonpad" target="_blank" rel="noopener">github.com/fortael/wootonpad</a>
      </div>
    </footer>

  </div>
</template>

<script setup>
// The demo window is a thin re-implementation of src/vue/components/App.vue:
// same components, same wrapper markup, same store fields — only the data is
// mocked and the Electron-facing callbacks are routed through the window.__sb
// / window.api stubs installed in src/landing/main.js. Nothing in
// src/vue/** is landing-aware.
import { ref, computed, onMounted, nextTick, watch } from 'vue';
import { store } from '../vue/store.js';

import SbIcon from '../vue/components/SbIcon.vue';
import TopNavApp from '../vue/components/TopNavApp.vue';
import CollapsedRailApp from '../vue/components/CollapsedRailApp.vue';
import CommandBar from '../vue/components/CommandBar.vue';
import FilterTabs from '../vue/components/FilterTabs.vue';
import AttentionRail from '../vue/components/AttentionRail.vue';
import SidebarApp from '../vue/components/SidebarApp.vue';
import SessionHeaderApp from '../vue/components/SessionHeaderApp.vue';
import AccountDropdownApp from '../vue/components/AccountDropdownApp.vue';
import AccountsApp from '../vue/components/AccountsApp.vue';
import ProjectsApp from '../vue/components/ProjectsApp.vue';
import PlansApp from '../vue/components/PlansApp.vue';
import MemoryApp from '../vue/components/MemoryApp.vue';
import ProjectViewerApp from '../vue/components/ProjectViewerApp.vue';
import {
  MOCK_ACCOUNTS,
  MOCK_ACTIVE_ACCOUNT_ID,
  MOCK_PROJECTS,
  MOCK_TERMINAL_LINES,
  MOCK_USAGE,
  MOCK_PLANS,
  MOCK_MEMORIES,
  MOCK_SELECTED_SESSION_ID,
  MOCK_VIEWER_PROJECT_PATH,
} from './mock-data.js';

const iconUrl = 'icon.png';

// ── Marketing chrome ─────────────────────────────────────────────
const stars = ref(null);

// ── Fake terminal spinner ────────────────────────────────────────
const SPIN_FRAMES = ['⠸', '⠼', '⠴', '⠦', '⠇', '⠏', '⠋', '⠙'];
let _spinIdx = 0;
const spinChar = ref(SPIN_FRAMES[0]);

// ── Template refs ────────────────────────────────────────────────
const accountDropdownRef = ref(null);
const accountsRef = ref(null);
const projectsRef = ref(null);
const plansRef = ref(null);
const memoryRef = ref(null);
const projectViewerRef = ref(null);

// ── Tab config (same list App.vue feeds TopNavApp) ───────────────
const TABS = [
  { id: 'sessions', icon: 'sparkles', label: 'Sessions' },
  { id: 'plans', icon: 'book-open', label: 'Plans' },
  { id: 'memory', icon: 'brain', label: 'Agent Files' },
  { id: 'stats', icon: 'chart-no-axes-column', label: 'Stats' },
  { id: 'projects', icon: 'folder', label: 'Projects' },
  { id: 'accounts', icon: 'users', label: 'Accounts' },
];

const FILTER_TABS = [
  { id: 'recent', label: 'Recent' },
  { id: 'running', label: 'Running' },
  { id: 'pinned', label: 'Pinned' },
  { id: 'today', label: 'Today' },
  { id: 'archived', label: 'Archived' },
];

// ── Search ───────────────────────────────────────────────────────
const searchPlaceholder = computed(() => {
  switch (store.activeTab) {
    case 'plans': return 'Search plans...';
    case 'memory': return 'Search agent files...';
    case 'projects': return 'Search projects…';
    default: return 'Search sessions...';
  }
});

let searchDebounceTimer = null;

function onSearchValue(value) {
  store.searchQuery = value;
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    searchDebounceTimer = null;
    const query = store.searchQuery.trim();
    if (!query) { doClearSearch(); return; }
    window.__sb?.search?.(query, store.searchTitlesOnly);
  }, 200);
}

function doClearSearch() {
  store.searchQuery = '';
  if (searchDebounceTimer) { clearTimeout(searchDebounceTimer); searchDebounceTimer = null; }
  window.__sb?.clearSearch?.();
}

function focusSearch() {
  document.querySelector('.lp-app-window .sbx-commandbar__input')?.focus();
}

function toggleTitlesOnly() {
  store.searchTitlesOnly = !store.searchTitlesOnly;
  if (store.searchQuery.trim()) {
    window.__sb?.search?.(store.searchQuery.trim(), store.searchTitlesOnly);
  }
}

// ── Theme ────────────────────────────────────────────────────────
// The app mirrors this onto <html data-theme>; the landing scopes it to the
// demo window instead (:data-theme on .lp-app-window) so flipping the app's
// theme does not repaint the marketing page around it.
function toggleTheme() {
  store.theme = store.theme === 'light' ? 'dark' : 'light';
}

// ── Active-session rail ──────────────────────────────────────────
const ATTENTION_ORDER = { waiting: 0, done: 1, running: 2, idle: 3 };

const attentionProjects = computed(() => {
  const out = [];
  for (const p of store.projects) {
    const live = p.sessions.filter(s => store.activePtyIds.has(s.sessionId));
    if (!live.length) continue;
    let status = 'idle';
    let reason = 'open';
    if (live.some(s => store.attentionSessions.has(s.sessionId))) {
      status = 'waiting'; reason = 'needs input';
    } else if (live.some(s => store.responseReadySessions.has(s.sessionId))) {
      status = 'done'; reason = 'response ready';
    } else if (live.some(s => store.sessionBusyState.get(s.sessionId))) {
      status = 'running'; reason = 'working';
    }
    out.push({
      projectPath: p.projectPath,
      name: p.projectPath.split('/').filter(Boolean).pop() || p.projectPath,
      status,
      reason,
      count: live.length,
    });
  }
  return out.sort((a, b) => ATTENTION_ORDER[a.status] - ATTENTION_ORDER[b.status]);
});

const attentionActiveName = computed(() =>
  attentionProjects.value.find(p => p.projectPath === store.attentionProject)?.name || ''
);

function onSelectAttentionName(name) {
  const hit = attentionProjects.value.find(p => p.name === name);
  if (hit) onSelectAttentionProject(hit.projectPath);
}

function onSelectAttentionProject(projectPath) {
  store.attentionProject = projectPath;
  const project = store.projects.find(p => p.projectPath === projectPath);
  const live = project?.sessions.filter(s => store.activePtyIds.has(s.sessionId)) || [];
  if (!live.length) return;
  const newest = live.reduce((a, b) => (new Date(b.modified || 0) > new Date(a.modified || 0) ? b : a));
  window.__sb?.openSession?.(newest);
}

// ── Tab switching ────────────────────────────────────────────────
function setTab(tabId) {
  if (tabId === store.activeTab) return;
  store.activeTab = tabId;
  store.searchQuery = '';
  store.searchMatchIds = null;
  store.searchMatchProjectPaths = null;
  window.__sb?.onTabChange?.(tabId);
}

// ── Filter tabs ──────────────────────────────────────────────────
function onFilterTab(id) {
  store.sessionFilterTab = id;
  store.showRunningOnly = id === 'running';
  store.showStarredOnly = id === 'pinned';
  store.showTodayOnly = id === 'today';
  store.showArchived = id === 'archived';
  window.__sb?.onFilterChange?.({
    showStarredOnly: store.showStarredOnly,
    showRunningOnly: store.showRunningOnly,
    showTodayOnly: store.showTodayOnly,
    showArchived: store.showArchived,
  });
}

function onViewMode(mode) {
  store.sidebarViewMode = mode;
  if ((mode === 'grid') !== store.gridViewActive) window.__sb?.toggleGridView?.();
}

// ── Sidebar action callbacks (identical shape to App.vue) ────────
function onGlobalSettings() { window.__sb?.openGlobalSettings?.(); }
function onResort() { window.__sb?.resort?.(); }
function onAddProject() { window.__sb?.addProject?.(); }

const sidebarCallbacks = {
  openSession: (s) => window.__sb?.openSession?.(s),
  stopSession: (id) => window.__sb?.stopSession?.(id),
  toggleStar: (id) => window.__sb?.toggleStar?.(id),
  archiveSession: (id) => window.__sb?.archiveSession?.(id),
  forkSession: (id) => window.__sb?.forkSession?.(id),
  showJsonl: (id) => window.__sb?.showJsonl?.(id),
  launchConfig: (id) => window.__sb?.launchConfig?.(id),
  renameSession: (id, name) => window.__sb?.renameSession?.(id, name),
  newSession: (project, btn) => window.__sb?.newSession?.(project, btn),
  openSettings: (path) => window.__sb?.openSettings?.(path),
  archiveSessions: (sessions) => window.__sb?.archiveSessions?.(sessions),
  removeProject: (path) => window.__sb?.removeProject?.(path),
};

const planCallbacks = { openPlan: (plan) => window.__sb?.openPlan?.(plan) };
const memoryCallbacks = { openMemory: (file) => window.__sb?.openMemory?.(file) };

const accountsCallbacks = {
  switchAccount: (id) => window.__sb?.switchAccount?.(id),
  openAccountHomeSession: (acc) => window.__sb?.openAccountHomeSession?.(acc),
  renameAccount: (id, name) => window.__sb?.renameAccount?.(id, name),
  deleteAccount: (id) => window.__sb?.deleteAccount?.(id),
  createAccount: (name) => window.__sb?.createAccount?.(name),
  discoverWslClaudeHomes: () => window.__sb?.discoverWslClaudeHomes?.(),
  createWslAccount: (distro, name) => window.__sb?.createWslAccount?.(distro, name),
};

const accountDropdownCallbacks = {
  switchAccount: (id) => {
    window.__sb?.switchAccount?.(id);
    accountDropdownRef.value?.setActiveAccount?.(id);
  },
};

const projectsCallbacks = {
  openProject: (p) => window.__sb?.openProject?.(p),
  newSession: (p, btn) => window.__sb?.newSession?.(p, btn),
  addProject: () => window.__sb?.addProject?.(),
  projectRemoved: () => window.__sb?.projectRemoved?.(),
};

const projectViewerCallbacks = {
  newSession: (p, btn) => window.__sb?.newSession?.(p, btn),
  onTabChange: (tab) => window.__sb?.onPvTabChange?.(tab),
  worktreeDeleted: () => {},
};

// ── Selected session → SessionHeaderApp + fake terminal ──────────
const activeSession = computed(() => {
  if (!store.activeSessionId) return null;
  for (const p of store.projects) {
    const s = p.sessions.find(x => x.sessionId === store.activeSessionId);
    if (s) return { ...s, projectPath: p.projectPath };
  }
  return null;
});

watch(activeSession, (s) => { store.headerSession = s; }, { immediate: true });

const terminalLines = computed(() =>
  store.activeSessionId ? (MOCK_TERMINAL_LINES[store.activeSessionId] || []) : []
);

// ── ProjectGroup lazy-collapse workaround ────────────────────────
// ProjectGroup.vue:198 initialises `collapsed` as `ref(() => …)`. A ref holds
// the function rather than calling it, so `collapsed.value` is always truthy
// and every freshly mounted group renders collapsed. Fixing that belongs in
// src/vue, which the landing must not touch — so expand each group once, the
// first time it appears, and leave later user toggles alone.
const expandedGroups = new Set();

function expandNewGroups() {
  for (const header of document.querySelectorAll('.lp-app-window #sidebar-content .project-header')) {
    if (expandedGroups.has(header.id)) continue;
    expandedGroups.add(header.id);
    if (header.classList.contains('collapsed')) header.querySelector('.arrow')?.click();
  }
}

watch(
  () => [store.activeTab, store.sessionFilterTab, store.searchMatchIds, store.sidebarCollapsed],
  () => nextTick(expandNewGroups)
);

onMounted(async () => {
  fetch('https://api.github.com/repos/fortael/wootonpad')
    .then(r => r.json())
    .then(d => { if (d.stargazers_count != null) stars.value = d.stargazers_count; })
    .catch(() => {});

  setInterval(() => {
    _spinIdx = (_spinIdx + 1) % SPIN_FRAMES.length;
    spinChar.value = SPIN_FRAMES[_spinIdx];
  }, 120);

  // Components that take their data through an exposed setter rather than the
  // store — same handshake App.vue performs in its own onMounted.
  accountDropdownRef.value?.setAccounts(MOCK_ACCOUNTS, MOCK_ACTIVE_ACCOUNT_ID, MOCK_USAGE);
  accountsRef.value?.setAccounts(MOCK_ACCOUNTS, MOCK_ACTIVE_ACCOUNT_ID);
  accountsRef.value?.setUsage(MOCK_USAGE);
  projectsRef.value?.setProjects(MOCK_PROJECTS);
  plansRef.value?.setPlans(MOCK_PLANS);
  memoryRef.value?.setMemories(MOCK_MEMORIES);
  projectViewerRef.value?.open({ projectPath: MOCK_VIEWER_PROJECT_PATH });

  await nextTick();
  expandNewGroups();
  store.activeSessionId = MOCK_SELECTED_SESSION_ID;
  store.attentionProject = activeSession.value?.projectPath || null;
});
</script>

