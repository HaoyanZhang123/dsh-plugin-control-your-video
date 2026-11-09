/**
 * Workbench visual language: the merged direction (light V4 / dark V1, unified blue system).
 *
 * Integration rules that are not cosmetic:
 * - the panel inherits the Host's dark flag (`body[data-ds-dark-theme]`) instead of owning a theme;
 * - the root type size follows `--dsh-content-font-size` when the Host publishes it;
 * - all colors live on `.avw-root` custom properties, so a future host-token mapping changes one
 *   block instead of every rule;
 * - the canvas keeps a neutral dark stage in both themes, because judging video on white lies.
 *
 * @module ui/client/styles
 */

export const AVW_CSS = `
.avw-root{
  --avw-bg:#eef2f6;--avw-bg-deep:#e6ecf2;--avw-panel:#fff;--avw-panel-2:#f5f8fb;--avw-elev:#e9eff6;
  --avw-line:#dde5ee;--avw-line-strong:#c4d1df;--avw-text:#0e1720;--avw-text-2:#47576a;--avw-text-3:#7c8b9c;
  --avw-accent:#1f6feb;--avw-accent-weak:rgba(31,111,235,.1);--avw-accent-2:#b9781f;
  --avw-ok:#0f7b57;--avw-warn:#9a6516;--avw-danger:#bf3b31;
  --avw-sel:rgba(31,111,235,.1);--avw-hover:rgba(20,40,70,.05);
  --avw-radius:3px;--avw-radius-sm:2px;--avw-radius-lg:4px;
  --avw-shadow:0 12px 32px rgba(20,40,70,.14);
  --avw-mono:"Cascadia Mono","Consolas","SFMono-Regular",monospace;
  --avw-stage:#f2f6fa;--avw-grid:rgba(31,111,235,.05);--avw-track:#fbfdff;
  --avw-clip:#fff;--avw-clip-line:#c9d8e8;--avw-clip-text:#3c4d60;
  --avw-canvas-border:6px solid #fff;--avw-canvas-shadow:0 2px 10px rgba(20,40,70,.18),0 0 0 1px #cdd9e6;
  --avw-chip:#f7fafc;--avw-field:#fff;--avw-seg:#f2f6fa;--avw-seg-on:#fff;
  --avw-drawer:#fff;--avw-toast:#0e1720;--avw-toast-text:#f4f8fc;
  --avw-canvas-bg:#0b0e12;
  position:relative;display:flex;flex-direction:column;width:100%;height:100%;min-height:0;
  background:var(--avw-bg);color:var(--avw-text);
  font-family:"Segoe UI","Microsoft YaHei","PingFang SC",system-ui,sans-serif;
  font-size:var(--dsh-content-font-size,13px);line-height:1.5;
  color-scheme:light;
}
body[data-ds-dark-theme] .avw-root{
  --avw-bg:#0b0c0e;--avw-bg-deep:#070809;--avw-panel:#111317;--avw-panel-2:#171a1f;--avw-elev:#1e2229;
  --avw-line:#23272e;--avw-line-strong:#343b45;--avw-text:#e9edf2;--avw-text-2:#98a3b0;--avw-text-3:#5c6672;
  --avw-accent:#41d1ff;--avw-accent-weak:rgba(65,209,255,.13);--avw-accent-2:#ffc761;
  --avw-ok:#43d787;--avw-warn:#f0b955;--avw-danger:#ff6b6b;
  --avw-sel:rgba(65,209,255,.16);--avw-hover:rgba(255,255,255,.05);
  --avw-shadow:0 18px 46px rgba(0,0,0,.55);
  --avw-stage:#0c0e11;--avw-grid:rgba(255,255,255,.035);--avw-track:#0c0e11;
  --avw-clip:linear-gradient(180deg,#1a1f26,#12161b);--avw-clip-line:#2d353f;--avw-clip-text:#98a3b0;
  --avw-canvas-border:1px solid #2c333c;--avw-canvas-shadow:0 22px 60px rgba(0,0,0,.65);
  --avw-chip:transparent;--avw-field:#0a0c0f;--avw-seg:#070809;--avw-seg-on:#1e2229;
  --avw-drawer:#0e1013;--avw-toast:#e9edf2;--avw-toast-text:#0b0c0e;
  color-scheme:dark;
}
.avw-root *{box-sizing:border-box}
.avw-root button{font:inherit;color:inherit;cursor:pointer}
.avw-root input,.avw-root textarea,.avw-root select{font:inherit;color:inherit}
.avw-root :focus-visible{outline:2px solid var(--avw-accent);outline-offset:2px}
.avw-root ::selection{background:var(--avw-accent-weak)}
.avw-root ::-webkit-scrollbar{width:8px;height:8px}
.avw-root ::-webkit-scrollbar-thumb{background:var(--avw-line-strong);border-radius:4px}
.avw-root ::-webkit-scrollbar-track{background:transparent}

/* ---------- top bar ---------- */
.avw-topbar{display:flex;align-items:center;gap:10px;height:44px;padding:0 12px;flex:none;
  border-bottom:1px solid var(--avw-line);background:var(--avw-panel);}
.avw-title{display:flex;align-items:baseline;gap:7px;min-width:0}
.avw-title b{font-size:13.5px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:340px}
.avw-title em{font:10.5px/1 var(--avw-mono);color:var(--avw-text-3);font-style:normal}
.avw-hsep{width:1px;height:18px;background:var(--avw-line);flex:none}
.avw-grow{flex:1;min-width:0}
.avw-tabs-surface{display:flex;padding:2px;border:1px solid var(--avw-line);border-radius:var(--avw-radius);background:var(--avw-bg-deep)}
.avw-tabs-surface button{padding:3px 11px;border:0;background:transparent;border-radius:var(--avw-radius-sm);
  color:var(--avw-text-3);font-size:12.5px}
.avw-tabs-surface button[aria-selected="true"]{background:var(--avw-seg-on);color:var(--avw-accent);box-shadow:0 0 0 1px var(--avw-line-strong) inset}

/* ---------- chips / buttons / fields ---------- */
.avw-chip{max-width:100%;overflow:hidden;text-overflow:ellipsis;display:inline-flex;align-items:center;gap:5px;padding:2px 7px;border-radius:var(--avw-radius-sm);
  border:1px solid var(--avw-line-strong);background:var(--avw-chip);color:var(--avw-text-2);
  font:10.5px/1.5 var(--avw-mono);white-space:nowrap}
.avw-chip i{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}
.avw-chip--ok{color:var(--avw-ok);border-color:color-mix(in srgb,var(--avw-ok) 38%,transparent)}
.avw-chip--warn{color:var(--avw-warn);border-color:color-mix(in srgb,var(--avw-warn) 36%,transparent)}
.avw-chip--danger{color:var(--avw-danger);border-color:color-mix(in srgb,var(--avw-danger) 36%,transparent)}
.avw-chip--accent{color:var(--avw-accent);border-color:color-mix(in srgb,var(--avw-accent) 36%,transparent)}
.avw-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:5px 11px;
  border:1px solid var(--avw-line-strong);border-radius:var(--avw-radius);background:var(--avw-panel);
  color:var(--avw-text);font-size:12.5px;white-space:nowrap}
.avw-btn:hover{border-color:var(--avw-accent);color:var(--avw-accent)}
.avw-btn[disabled]{opacity:.45;cursor:not-allowed}
.avw-btn--primary{background:var(--avw-accent);border-color:var(--avw-accent);color:#fff;font-weight:600}
body[data-ds-dark-theme] .avw-btn--primary{color:#001015}
.avw-btn--primary:hover{color:#fff;filter:brightness(1.05)}
.avw-btn--ghost{border-color:transparent;background:transparent;color:var(--avw-text-2)}
.avw-btn--ghost:hover{background:var(--avw-hover);color:var(--avw-text)}
.avw-btn--sm{padding:3px 8px;font-size:11.5px}
.avw-btn--icon{padding:5px;width:28px;height:28px}
.avw-btn svg{width:14px;height:14px;flex:none}
.avw-field{display:flex;align-items:center;gap:6px;height:29px;padding:0 9px;
  border:1px solid var(--avw-line);border-radius:var(--avw-radius);background:var(--avw-field);color:var(--avw-text-3)}
.avw-field input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:var(--avw-text)}
.avw-field svg{width:14px;height:14px;flex:none}

/* ---------- home ---------- */
.avw-scroll{flex:1;min-height:0;overflow:auto}
.avw-home{padding:18px 22px 24px;max-width:1280px}
.avw-home-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px}
.avw-home-head h1{margin:0;font-size:19px;font-weight:650;letter-spacing:.01em}
.avw-home-head p{margin:1px 0 0;color:var(--avw-text-3);font-size:11.5px}
.avw-home-grid{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(300px,.85fr);gap:14px;align-items:start}
.avw-card{border:1px solid var(--avw-line);border-radius:var(--avw-radius-lg);background:var(--avw-panel)}
.avw-card__head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--avw-line)}
.avw-card__title{font-weight:600;font-size:12.5px}
.avw-card__note{color:var(--avw-text-3);font:10px/1.5 var(--avw-mono)}
.avw-card__body{padding:12px}
.avw-empty{display:flex;flex-direction:column;align-items:center;gap:8px;padding:44px 20px;color:var(--avw-text-3);text-align:center}
.avw-empty b{color:var(--avw-text-2);font-weight:600}
.avw-empty p{margin:0;max-width:460px;font-size:12px;line-height:1.7}
.avw-empty svg{width:28px;height:28px;opacity:.5}

/* continue card */
.avw-continue{display:grid;grid-template-columns:132px minmax(0,1fr) auto;gap:12px;align-items:center}
.avw-thumb{position:relative;aspect-ratio:16/9;border:1px solid var(--avw-line-strong);border-radius:var(--avw-radius);overflow:hidden;background:linear-gradient(150deg,#16202b,#0a0f15)}
.avw-thumb::after{content:"";position:absolute;inset:0;background:radial-gradient(120% 120% at 20% 10%,rgba(255,255,255,.16),transparent 55%)}
.avw-thumb span{position:absolute;inset:0;display:grid;place-items:center;z-index:2;color:#fff}
.avw-thumb svg{width:16px;height:16px}
.avw-continue-meta{display:grid;gap:4px;min-width:0}
.avw-continue-meta b{font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.avw-continue-meta small{color:var(--avw-text-3);font-size:11.5px}
.avw-continue-row{display:flex;gap:8px;flex-wrap:wrap;color:var(--avw-text-3);font-size:11px}
.avw-continue-row b{font-family:var(--avw-mono);font-weight:500;color:var(--avw-text-2)}

/* start composer */
.avw-start{margin-top:12px}
.avw-start-box{border:1px solid var(--avw-line-strong);border-radius:var(--avw-radius-lg);background:var(--avw-bg-deep);overflow:hidden}
.avw-start-box textarea{display:block;width:100%;min-height:84px;padding:11px 12px;border:0;outline:0;resize:vertical;background:transparent}
.avw-start-bar{display:flex;align-items:center;gap:7px;flex-wrap:wrap;padding:7px 9px;border-top:1px solid var(--avw-line)}
.avw-start-hint{color:var(--avw-text-3);font-size:11px;margin-right:auto}
.avw-start-tpl{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.avw-tpl{padding:4px 9px;border:1px dashed var(--avw-line-strong);border-radius:var(--avw-radius-sm);
  background:transparent;color:var(--avw-text-2);font-size:11px}
.avw-tpl:hover{border-style:solid;border-color:var(--avw-accent);color:var(--avw-accent)}

/* todo */
.avw-todo{display:grid;gap:8px}
.avw-todo-item{display:grid;grid-template-columns:18px minmax(0,1fr) auto;gap:8px;align-items:start;
  padding:9px 10px;border:1px solid var(--avw-line);border-radius:var(--avw-radius);background:var(--avw-panel-2)}
.avw-todo-item b{font-size:12.5px;font-weight:550}
.avw-todo-item p{margin:2px 0 0;color:var(--avw-text-3);font-size:11.5px;line-height:1.55}
.avw-todo-item svg{width:16px;height:16px;color:var(--avw-accent-2);margin-top:2px}
.avw-todo-actions{display:flex;gap:6px}

/* project rows */
.avw-rows{display:grid;gap:1px}
.avw-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:3px 10px;align-items:center;
  padding:9px 10px;border:1px solid transparent;border-radius:var(--avw-radius);text-align:left;background:transparent}
.avw-row:hover{background:var(--avw-panel-2);border-color:var(--avw-line)}
.avw-row-name{display:flex;align-items:center;gap:6px;min-width:0;font-size:12.5px;font-weight:550}
.avw-row-name span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.avw-row-meta{grid-column:1/2;display:flex;gap:10px;flex-wrap:wrap;color:var(--avw-text-3);font-size:10.5px}
.avw-row-meta em{font-style:normal;font-family:var(--avw-mono);color:var(--avw-text-2)}
.avw-row-side{justify-self:end;display:flex;gap:6px;align-items:center}

/* ---------- workbench ---------- */
.avw-ws{flex:1;display:grid;grid-template-rows:minmax(0,1fr) auto auto;min-height:0}
.avw-cols{display:grid;grid-template-columns:var(--avw-left,268px) minmax(0,1fr) var(--avw-right,308px);min-height:0}
.avw-col{display:flex;flex-direction:column;min-height:0;min-width:0;background:var(--avw-panel)}
.avw-col--left{border-right:1px solid var(--avw-line)}
.avw-col--right{border-left:1px solid var(--avw-line);overflow:hidden}
.avw-col--center{background:var(--avw-bg-deep)}
.avw-pane-head{display:flex;align-items:center;gap:6px;height:32px;padding:0 9px;flex:none;
  border-bottom:1px solid var(--avw-line);background:var(--avw-panel-2);color:var(--avw-text-3);
  font:10px/1 var(--avw-mono);letter-spacing:.09em}
.avw-pane-head b{font-family:inherit;font-size:11.5px;letter-spacing:.02em;color:var(--avw-text-2)}
.avw-pane-body{flex:1;min-height:0;overflow:auto;padding:6px}

/* tree */
.avw-tree{display:flex;flex-direction:column;gap:1px;font-size:12.5px}
.avw-tree-item{display:flex;align-items:center;gap:6px;padding:4px 7px;border-radius:var(--avw-radius-sm);
  border:1px solid transparent;background:transparent;color:var(--avw-text-2);text-align:left;white-space:nowrap}
.avw-tree-item:hover{background:var(--avw-hover);color:var(--avw-text)}
.avw-tree-item[aria-selected="true"]{background:var(--avw-sel);color:var(--avw-text);box-shadow:inset 2px 0 0 var(--avw-accent)}
.avw-tree-item svg{width:13px;height:13px;opacity:.7;flex:none}
.avw-tree-item .meta{margin-left:auto;color:var(--avw-text-3);font:10px var(--avw-mono)}
.avw-tree-group{margin-top:10px}
.avw-tree-group>.avw-pane-head{border:0;background:transparent;height:22px}
.avw-tree-depth1{padding-left:20px}
.avw-tree-depth2{padding-left:36px}

/* right tabs */
.avw-rtabs{display:flex;gap:2px;padding:6px 8px 0;border-bottom:1px solid var(--avw-line);flex:none}
.avw-rtabs button{padding:5px 9px 6px;border:0;border-bottom:2px solid transparent;background:transparent;
  color:var(--avw-text-3);font:10.5px/1.4 var(--avw-mono);letter-spacing:.03em}
.avw-rtabs button[aria-selected="true"]{color:var(--avw-accent);border-bottom-color:var(--avw-accent)}
.avw-rtabs .badge{color:var(--avw-accent-2);margin-left:4px;font-size:9.5px}
.avw-objhead{display:flex;gap:8px;align-items:center;padding:9px 11px;border-bottom:1px solid var(--avw-line);background:var(--avw-panel-2)}
.avw-objhead i{display:grid;place-items:center;width:25px;height:25px;border:1px solid var(--avw-line-strong);
  border-radius:var(--avw-radius-sm);color:var(--avw-accent);font-style:normal;flex:none}
.avw-objhead b{display:block;font-size:12.5px;font-weight:600}
.avw-objhead small{display:block;color:var(--avw-text-3);font:10px var(--avw-mono)}
.avw-props{flex:1;min-height:0;overflow:auto}
.avw-prop{border-bottom:1px solid var(--avw-line);padding:9px 11px 11px}
.avw-prop h4{margin:0 0 7px;color:var(--avw-text-3);font:10px/1.4 var(--avw-mono);letter-spacing:.07em;font-weight:500}
.avw-kv{display:grid;grid-template-columns:76px minmax(0,1fr);gap:7px;align-items:center;margin-bottom:6px}
.avw-kv label{color:var(--avw-text-3);font-size:11px}
.avw-kv .v{min-width:0;padding:4px 7px;border:1px solid var(--avw-input-border,var(--avw-line));border-radius:var(--avw-radius-sm);
  background:var(--avw-field);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.avw-kv input,.avw-kv textarea{width:100%;padding:4px 7px;border:1px solid var(--avw-line);border-radius:var(--avw-radius-sm);
  background:var(--avw-field);outline:0}
.avw-kv textarea{min-height:56px;resize:vertical;white-space:pre-wrap}
.avw-mono{font-family:var(--avw-mono)}
.avw-hint{color:var(--avw-text-3);font-size:10.5px;line-height:1.6;margin:6px 0 0}

/* stage / canvas */
.avw-stage{position:relative;flex:1;min-height:0;display:flex;flex-direction:column}
.avw-stage-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:6px 9px;border-bottom:1px solid var(--avw-line);
  background:var(--avw-panel);color:var(--avw-text-3);font-size:11px;flex:none}
.avw-stage-bar .sep{width:1px;height:15px;background:var(--avw-line)}
.avw-canvas-wrap{flex:1;min-height:0;display:grid;place-items:center;padding:16px;overflow:hidden;
  background:linear-gradient(90deg,var(--avw-grid) 1px,transparent 1px) 0 0/40px 40px,
             linear-gradient(0deg,var(--avw-grid) 1px,transparent 1px) 0 0/40px 40px,var(--avw-bg-deep)}
.avw-canvas{position:relative;width:min(100%,900px);aspect-ratio:16/9;background:var(--avw-canvas-bg);
  border:var(--avw-canvas-border);border-radius:var(--avw-radius-sm);box-shadow:var(--avw-canvas-shadow);overflow:hidden}
.avw-canvas-empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;
  padding:24px;color:#8b96a3;text-align:center}
.avw-canvas-empty b{color:#c7d2de;font-weight:600;font-size:13px}
.avw-canvas-empty p{margin:0;max-width:440px;font-size:11.5px;line-height:1.7;color:#7d8895}
.avw-safe{position:absolute;inset:5%;border:1px dashed rgba(255,255,255,.18);pointer-events:none}
.avw-safe::after{content:"安全框";position:absolute;top:-15px;left:0;color:rgba(255,255,255,.32);font:9px var(--avw-mono)}
.avw-selbox{position:absolute;border:1px solid var(--avw-accent);background:color-mix(in srgb,var(--avw-accent) 10%,transparent);border-radius:1px}
.avw-selbox::before,.avw-selbox::after{content:"";position:absolute;width:6px;height:6px;background:var(--avw-accent)}
.avw-selbox::before{left:-3px;top:-3px}.avw-selbox::after{right:-3px;bottom:-3px}
.avw-seltag{position:absolute;padding:1px 6px;border-radius:1px;background:var(--avw-accent);color:#fff;font-size:10px;white-space:nowrap}
.avw-transport{display:flex;align-items:center;gap:7px;flex-wrap:wrap;padding:7px 10px;border-top:1px solid var(--avw-line);
  background:var(--avw-panel);flex:none}
.avw-timecode{padding:4px 7px;border:1px solid var(--avw-line);border-radius:var(--avw-radius-sm);
  background:var(--avw-panel-2);font:11px var(--avw-mono);letter-spacing:.02em}
.avw-timecode small{color:var(--avw-text-3)}
.avw-transport .grow{flex:1}
.avw-disabled-reason{color:var(--avw-text-3);font-size:10.5px}

/* timeline */
.avw-timeline{height:var(--avw-timeline,252px);min-height:0;display:flex;flex-direction:column;flex:none;
  border-top:1px solid var(--avw-line);background:var(--avw-panel)}
.avw-timeline-head{display:flex;align-items:center;gap:8px;height:30px;padding:0 10px;flex:none;
  border-bottom:1px solid var(--avw-line);color:var(--avw-text-3);font:10px var(--avw-mono)}
.avw-timeline-head b{font-family:inherit;color:var(--avw-text-2);font-size:11px}
.avw-timeline-head .zoom{margin-left:auto;display:flex;align-items:center;gap:5px}
.avw-timeline-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;
  color:var(--avw-text-3);text-align:center;padding:18px}
.avw-timeline-empty b{color:var(--avw-text-2);font-size:12px;font-weight:600}
.avw-timeline-empty p{margin:0;max-width:520px;font-size:11.5px;line-height:1.7}
.avw-ruler{display:grid;grid-template-columns:118px minmax(0,1fr);height:24px;border-bottom:1px solid var(--avw-line);
  background:var(--avw-panel)}
.avw-ruler-corner{border-right:1px solid var(--avw-line)}
.avw-ruler-ticks{position:relative;font:9px/24px var(--avw-mono);color:var(--avw-text-3)}
.avw-ruler-ticks span{position:absolute;top:0;transform:translateX(-50%)}
.avw-track{display:grid;grid-template-columns:118px minmax(0,1fr);border-bottom:1px solid var(--avw-line)}
.avw-track-label{display:flex;align-items:center;gap:5px;padding:0 8px;border-right:1px solid var(--avw-line);
  background:var(--avw-panel);color:var(--avw-text-3);font-size:11px;white-space:nowrap;overflow:hidden}
.avw-track-lane{position:relative;height:28px;background:
  repeating-linear-gradient(90deg,transparent 0 79px,var(--avw-grid) 79px 80px),var(--avw-track)}
.avw-clip{position:absolute;top:3px;bottom:3px;display:flex;align-items:center;padding:0 6px;border-radius:1px;
  border:1px solid var(--avw-clip-line);background:var(--avw-clip);color:var(--avw-clip-text);
  font-size:10.5px;white-space:nowrap;overflow:hidden}
.avw-playhead{position:absolute;left:calc(118px + 18%);top:0;bottom:0;width:1px;background:var(--avw-accent)}
.avw-playhead::before{content:"";position:absolute;left:-4px;top:0;width:9px;height:7px;background:var(--avw-accent);clip-path:polygon(0 0,100% 0,50% 100%)}

/* status bar */
.avw-statusbar{display:flex;align-items:center;gap:12px;height:23px;padding:0 11px;flex:none;
  border-top:1px solid var(--avw-line);background:var(--avw-panel);color:var(--avw-text-3);font:9.5px var(--avw-mono)}
.avw-statusbar .grow{flex:1}

/* assistant drawer */
.avw-drawer{display:flex;flex-direction:column;min-height:0;min-width:0;height:100%;overflow:hidden;background:var(--avw-drawer)}
.avw-drawer>*{min-width:0}
.avw-drawer .avw-compose{min-width:0;overflow:hidden}
.avw-drawer .avw-compose textarea{max-width:100%}
.avw-chat{overflow-x:hidden}
.avw-chat{flex:1;min-height:0;overflow:auto;padding:10px;display:flex;flex-direction:column;gap:8px}
.avw-msg{padding:8px 10px;border:1px solid var(--avw-line);border-radius:var(--avw-radius);background:var(--avw-panel-2)}
.avw-msg small{display:block;color:var(--avw-text-3);font:9.5px var(--avw-mono);margin-bottom:3px}
.avw-msg p{margin:0;font-size:12px;line-height:1.65;white-space:pre-wrap;word-break:break-word}
.avw-msg--pending{border-style:dashed}
.avw-refs{display:flex;gap:5px;flex-wrap:wrap;margin-top:6px}
.avw-compose{padding:9px;border-top:1px solid var(--avw-line);background:var(--avw-panel)}
.avw-compose textarea{display:block;width:100%;min-height:64px;padding:7px 8px;border:1px solid var(--avw-line);
  border-radius:var(--avw-radius);background:var(--avw-field);outline:0;resize:vertical;font-size:12px}
.avw-compose-bar{display:flex;align-items:center;gap:6px;margin-top:6px;flex-wrap:wrap;justify-content:space-between}
.avw-compose-hint{flex:1 1 100%;order:3;min-width:0;margin-top:2px;color:var(--avw-text-3);font-size:10px;line-height:1.5}
.avw-compose-bar .avw-btn{flex:none;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.avw-refs{min-width:0;flex-wrap:wrap}
.avw-refs .avw-chip{max-width:100%}

/* gap card */
.avw-gap{padding:11px 12px;border:1px solid color-mix(in srgb,var(--avw-warn) 35%,transparent);
  background:color-mix(in srgb,var(--avw-warn) 6%,transparent);border-radius:var(--avw-radius);
  color:var(--avw-text);font-size:12px;line-height:1.65}
.avw-gap b{color:var(--avw-warn);font-weight:600}
.avw-gap small{display:block;margin-top:4px;color:var(--avw-text-3);font-size:10.5px}

/* modal / toast */
.avw-overlay{position:absolute;inset:0;z-index:20;display:grid;place-items:center;padding:24px;
  background:rgba(4,8,14,.45);backdrop-filter:blur(2px)}
.avw-modal{width:min(560px,100%);max-height:80%;overflow:auto;border:1px solid var(--avw-line-strong);
  border-radius:var(--avw-radius-lg);background:var(--avw-panel);box-shadow:var(--avw-shadow)}
.avw-modal-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--avw-line)}
.avw-modal-head b{font-size:13px}
.avw-modal-body{padding:14px}
.avw-modal-foot{display:flex;justify-content:flex-end;gap:8px;padding:10px 14px;border-top:1px solid var(--avw-line)}
.avw-toast{position:absolute;left:50%;bottom:36px;transform:translateX(-50%);z-index:30;max-width:640px;
  padding:7px 12px;border-radius:var(--avw-radius);background:var(--avw-toast);color:var(--avw-toast-text);
  font-size:12px;box-shadow:var(--avw-shadow)}
.avw-toast--error{background:var(--avw-danger);color:#fff}

/* tools / preferences */
.avw-page{padding:16px 20px;max-width:1120px}
.avw-page h2{margin:0 0 3px;font-size:17px;font-weight:650}
.avw-page>p{margin:0 0 14px;color:var(--avw-text-3);font-size:11.5px}
.avw-tool{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 10px;padding:10px 11px;
  border:1px solid var(--avw-line);border-radius:var(--avw-radius);background:var(--avw-panel);text-align:left}
.avw-tool:hover{border-color:var(--avw-line-strong)}
.avw-tool b{font-size:12.5px;font-weight:600;display:flex;align-items:center;gap:6px}
.avw-tool p{margin:2px 0 0;color:var(--avw-text-3);font-size:11.5px;line-height:1.55}
.avw-tool .side{justify-self:end;display:flex;align-items:center;gap:6px}
.avw-tools{display:grid;gap:8px}
.avw-pref-group{border:1px solid var(--avw-line);border-radius:var(--avw-radius-lg);background:var(--avw-panel);margin-bottom:10px;overflow:hidden}
.avw-pref-group h3{margin:0;padding:9px 11px;border-bottom:1px solid var(--avw-line);font-size:12.5px;font-weight:600;background:var(--avw-panel-2)}
.avw-pref-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(180px,auto);gap:10px;align-items:center;padding:8px 11px;border-bottom:1px solid var(--avw-line)}
.avw-pref-row:last-child{border-bottom:0}
.avw-pref-row b{display:block;font-size:12px;font-weight:550}
.avw-pref-row small{color:var(--avw-text-3);font-size:10.5px}
.avw-pref-row input[type="text"],.avw-pref-row input[type="number"],.avw-pref-row select{width:100%;max-width:260px;padding:4px 7px;
  border:1px solid var(--avw-line);border-radius:var(--avw-radius-sm);background:var(--avw-field);outline:0;font-size:12px}
.avw-switch{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:var(--avw-text-2)}

/* narrow overrides */
.avw-root[data-mode="narrow"] .avw-home-grid{grid-template-columns:1fr}
.avw-root[data-mode="narrow"] .avw-continue{grid-template-columns:110px minmax(0,1fr)}
.avw-root[data-mode="narrow"] .avw-continue .avw-btn{grid-column:1/-1}
@media (max-width: 900px){
  .avw-home-grid{grid-template-columns:1fr}
  .avw-continue{grid-template-columns:110px minmax(0,1fr)}
}

/* materials */
.avw-materials{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:9px}
.avw-material{display:grid;grid-template-columns:64px minmax(0,1fr);gap:9px;align-items:center;padding:8px;text-align:left;
  border:1px solid var(--avw-line);border-radius:var(--avw-radius);background:var(--avw-panel-2);min-width:0}
.avw-material:hover{border-color:var(--avw-line-strong)}
.avw-material[aria-selected="true"]{border-color:var(--avw-accent);box-shadow:0 0 0 1px var(--avw-accent) inset;background:var(--avw-sel)}
.avw-material-plate{position:relative;aspect-ratio:4/3;border:1px solid var(--avw-line);border-radius:2px;overflow:hidden;
  display:grid;place-items:center;color:var(--avw-text-3);background:var(--avw-bg-deep)}
.avw-material-plate img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.avw-material-meta{display:grid;gap:2px;min-width:0}
.avw-material-meta b{font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.avw-material-meta small{color:var(--avw-text-3);font-size:10px;line-height:1.45;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* brief */
.avw-brief{border-left:2px solid var(--avw-line-strong);padding:2px 0 2px 9px}
.avw-brief--user{border-left-color:var(--avw-accent)}
.avw-brief--source{border-left-color:var(--avw-accent-2)}
.avw-brief--ai{border-left-style:dashed;border-left-color:var(--avw-text-3)}
.avw-brief-label{display:flex;align-items:baseline;gap:7px;margin-bottom:3px}
.avw-brief-label b{font-size:11.5px;color:var(--avw-text-2)}
.avw-brief-label span{color:var(--avw-text-3);font-size:10px}
.avw-brief textarea{width:100%;min-height:46px;padding:6px 8px;border:1px solid var(--avw-line);border-radius:2px;
  background:var(--avw-field);outline:0;resize:vertical;font-size:12px;line-height:1.6}
/* narrow drawers */
.avw-cols--narrow{grid-template-columns:minmax(0,1fr)}
.avw-drawer-left,.avw-drawer-right{position:absolute;top:0;bottom:0;z-index:8;width:min(320px,86%);display:flex;flex-direction:column;
  background:var(--avw-panel);border:1px solid var(--avw-line-strong);box-shadow:var(--avw-shadow)}
.avw-drawer-left{left:0;border-left:0}
.avw-drawer-right{right:0;border-right:0}
/* tool detail bits */
.avw-tool-meta{display:flex;gap:5px;flex-wrap:wrap;margin-top:3px}
.avw-guidance{display:grid;gap:4px;padding:8px 9px;border:1px solid var(--avw-line);border-radius:2px;background:var(--avw-panel-2);
  font-size:11.5px;line-height:1.6;max-height:220px;overflow:auto}
.avw-guidance-line{white-space:pre-wrap;word-break:break-word}
.avw-start-title{font-family:inherit}

/* narrow topbar keeps the primary actions reachable instead of clipping them */
.avw-root[data-mode="narrow"] .avw-topbar{gap:6px;padding:0 8px;overflow-x:auto;scrollbar-width:none}
.avw-root[data-mode="narrow"] .avw-topbar::-webkit-scrollbar{display:none}
.avw-root[data-mode="narrow"] .avw-title b{max-width:150px}
.avw-root[data-mode="narrow"] .avw-topbar > .avw-chip{display:none}
.avw-root[data-mode="medium"] .avw-title b{max-width:220px}
.avw-root[data-mode="narrow"] .avw-home-head .field{width:100%}
.avw-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
`
