const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

// Only native objects/dispatch are modelled. Every assertion drives the shipped
// configure/act functions and actual registered provider callbacks in Lua.
const setup = String.raw`
local providers,events,rules,ruleRecords={},{},{},{}
local nativeConfig={["general.layout"]="dwindle",["group.groupbar.enabled"]=false}
local m1={id=1,name="A",description="Panel A",width=1200,height=900,scale=1,x=0,y=0,reserved={top=30,bottom=10,left=20,right=20}}
local m2={id=2,name="B",description="Panel B",width=2400,height=1600,scale=2,x=1200,y=0,reserved={top=40}}
local monitors={m1,m2}
local ws={id=11,name="11",monitor=m1,tiled_layout="dwindle"}
local ws2={id=12,name="12",monitor=m2,tiled_layout="dwindle"}
m1.active_workspace=ws; m2.active_workspace=ws2
local windows,active,activews={},nil,ws
local function eq(a,b) assert(a==b,tostring(a).." != "..tostring(b)) end
local function rejected(fn,pattern) local ok,err=pcall(fn); assert(not ok,"expected rejection"); assert(tostring(err):match(pattern),tostring(err)) end
local function win(id)
 local w={stable_id=id,address="0x"..id,mapped=true,workspace=ws,at={x=100,y=100},size={width=400,height=300},floating=false,fullscreen=0}
 windows[#windows+1]=w; return w
end
local a,b,c=win(1),win(2),win(3); active=a
local function frozen(w) return {address=w.address,stableId=tostring(w.stable_id),workspace=tostring(w.workspace.id)} end
local function target(w)
 local t={window=w,box={x=0,y=0,w=0,h=0}}
 function t:place(f) self.box=f; local selected=self.window; selected.at={x=f.x,y=f.y}; selected.size={width=f.w,height=f.h} end
 return t
end
local ta,tb,tc=target(a),target(b),target(c)
local ctx={area={x=20,y=30,w=1160,h=860},targets={ta,tb,tc}}
local function recalc()
 local p=providers[(ws.tiled_layout:gsub("^lua:",""))]
 if p then p.recalculate(ctx) end
end
local function action(kind)
 return function(args)
  return function()
   local w=args.window
   if kind=="float" then
    assert(args.action=="enable" or args.action=="disable")
    w.floating=args.action=="enable"
    local found
    for i,t in ipairs(ctx.targets) do if t.window==w then found=i end end
    if w.floating and found then table.remove(ctx.targets,found) elseif not w.floating and not found then ctx.targets[#ctx.targets+1]=target(w) end
    recalc()
   elseif kind=="resize" then assert(args.relative==false); w.size={width=args.x,height=args.y}
   elseif kind=="move" then
    if args.monitor then w.workspace=args.monitor.active_workspace
    elseif args.workspace then w.workspace=args.workspace
    else assert(args.relative==false); w.at={x=args.x,y=args.y} end
   elseif kind=="fullscreen" then
    w.fullscreen=args.action=="unset" and 0 or (args.action=="toggle" and (w.fullscreen==0 and 2 or 0) or 2)
   elseif kind=="focus" then activews=tonumber(args.workspace)==11 and ws or ws2 end
   return {ok=true}
  end
 end
end
hl={layout={register=function(name,p) assert(not providers[name]); providers[name]=p end},
 get_windows=function() return windows end,get_monitors=function() return monitors end,
 get_workspaces=function() return {ws,ws2} end,
 get_workspace=function(selector) if tostring(selector)=="11" then return ws elseif tostring(selector)=="12" then return ws2 end end,
 get_monitor=function(name) for _,m in ipairs(monitors) do if m.name==name then return m end end end,
 get_active_window=function() return active end,get_active_workspace=function() return activews end,
 get_config=function(key) return nativeConfig[key] end,
 on=function(event,fn) events[event]=fn; return {remove=function() events[event]=nil end} end,
 workspace_rule=function(spec)
  rules[#rules+1]=spec; local selector=tostring(spec.workspace)
  local w=selector=="11" and ws or ws2
  local record=ruleRecords[selector]
  if not record or not record.enabled then
   record={enabled=true}; ruleRecords[selector]=record
   function record:set_enabled(value)
    self.enabled=value
    w.tiled_layout=value and self.layout or "dwindle"
   end
   function record:is_enabled() return self.enabled end
  end
  record.layout=spec.layout
  w.tiled_layout=record.enabled and record.layout or "dwindle"
  return record
 end,
 dispatch=function(fn) return fn() end,
 dsp={window={float=action("float"),resize=action("resize"),move=action("move"),fullscreen=action("fullscreen")},focus=action("focus")}}
local W=dofile(BACKEND)
local spec={id="focus",kind="ratio",orientation="columns",weights={25,50,25},cells={{100},{100},{100}},fill="largest",underfill="hold",overflow="last",gridColumns=0}
local config={enabled=true,layouts={spec},workspaces={["11"]="focus"},monitors={},customSizes={}}
W.configure(config); recalc()
`
function lua(body, env = {}) {
  const source = `BACKEND=${JSON.stringify(path.join(__dirname, '..', 'WindowActions.lua'))}\n${setup}\n${body}`
  const result = spawnSync('lua', ['-'], {
    input: source,
    encoding: 'utf8',
    env: { ...process.env, XDG_RUNTIME_DIR: '', HYPRLAND_INSTANCE_SIGNATURE: '', ...env }
  })
  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.status, 0, result.stderr || result.stdout)
}

test('absolute direct jumps swap only destination and repeated commands are no-ops', () => lua(`
W.act("place-left",frozen(a)); eq(ta.box.x,20)
local center=tb.box.x
W.act("place-right",frozen(a)); eq(ta.box.x,890); eq(tb.box.x,center); eq(tc.box.x,20)
local right=ta.box.x; W.act("place-right",frozen(a)); eq(ta.box.x,right); eq(tb.box.x,center)
W.act("restore",frozen(a)); eq(ta.box.x,310)
`))

test('empty held slots remain reachable, explicit target is not active', () => lua(`
ctx.targets={ta}; b.mapped=false; c.mapped=false; recalc()
active=nil; W.act("place-right",frozen(a)); eq(ta.box.x,890)
W.act("place-left",frozen(a)); eq(ta.box.x,20)
`))

test('group tab cycling, membership changes, split and merge preserve one surviving slot', () => lua(`
local d=win(4); a.group={members={a,d},current=a}; d.group=a.group
recalc(); W.act("place-right",frozen(a)); eq(ta.box.x,890)
a.group.current=d; ta.window=d; recalc(); eq(ta.box.x,890)
local e=win(5); e.group=a.group; a.group.members={a,d,e}; recalc(); eq(ta.box.x,890)
a.group=nil; d.group.members={d,e}; ctx.targets[#ctx.targets+1]=target(a); recalc(); eq(ta.box.x,890)
local seen={}; for _,t in ipairs(ctx.targets) do local k=t.box.x..":"..t.box.y; assert(not seen[k]); seen[k]=true end
ctx.targets={ta,tb,tc}; d.group.members={a,d,e}; a.group=d.group; recalc(); eq(ta.box.x,890)
`))

test('mixed DPI work areas, fixed snaps, manual baseline refresh and custom dimensions', () => lua(`
local original={x=a.at.x,y=a.at.y}
W.act("left-half",frozen(a)); eq(a.floating,true); eq(a.at.x,20); eq(a.at.y,30); eq(a.size.width,580); eq(a.size.height,860)
W.act("right-half",frozen(a)); W.act("restore",frozen(a)); eq(a.floating,false)
W.act("left-half",frozen(a)); a.at={x=50,y=100}; a.size={width=300,height=250}
W.act("center",frozen(a)); W.act("restore",frozen(a)); eq(a.at.x,50); eq(a.at.y,100); eq(a.size.width,300)
config.customSizes={{id="small",width="50%",height="400",anchor="bottom-right",offsetX=0,offsetY=0}}; W.configure(config)
W.act("custom:small",frozen(a)); eq(a.size.width,580); eq(a.at.x,600); eq(a.at.y,490)
W.act("next-display",frozen(a)); eq(a.workspace,ws2); eq(a.size.width,580)
W.act("left-half",frozen(a)); eq(a.at.x,1200); eq(a.at.y,40); eq(a.size.width,600); eq(a.size.height,760)
monitors={m1}; ws2.monitor=m1; W.act("restore",frozen(a)); assert(a.at.x>=20 and a.at.x+a.size.width<=1180)
`))

test('display moves keep tiled windows tiled and leave native destination layouts unchanged', () => lua(`
W.act("next-display",frozen(a))
eq(a.workspace,ws2); eq(a.floating,false); eq(ws2.tiled_layout,"dwindle")
W.act("previous-display",frozen(a))
eq(a.workspace,ws); eq(a.floating,false); eq(ws.tiled_layout,"lua:omacast-focus")
W.act("place-left",frozen(a))
eq(a.floating,false); eq(a.at.x,20); eq(a.size.width,290)
`))

test('display moves retain Restore through synchronous destination layout reconciliation', () => lua(`
local d=win(4); d.workspace=ws2
local move=hl.dsp.window.move
hl.dsp.window.move=function(args)
 local command=move(args)
 return function()
  local result=command()
  if args.monitor or args.workspace then
   ctx.targets={}
   for _,w in ipairs(windows) do
    if w.workspace==ws and not w.floating then ctx.targets[#ctx.targets+1]=target(w) end
   end
   recalc()
  end
  return result
 end
end
W.act("previous-display",frozen(d))
eq(d.workspace,ws); eq(d.floating,false)
W.act("restore",frozen(d))
eq(d.workspace,ws2); eq(d.floating,false); eq(ws2.tiled_layout,"dwindle")
`))

test('stale identities, unsupported operations and native failures reject without fake success', () => lua(`
local t=frozen(a); a.stable_id=99
rejected(function() W.act("left-half",t) end,"reused")
a.stable_id=1; a.workspace=ws2
rejected(function() W.act("left-half",t) end,"changed workspace")
a.workspace=ws
rejected(function() W.act("not-an-action",t) end,"unsupported")
ws.tiled_layout="dwindle"; rejected(function() W.act("place-left",t) end,"assign an OmaCast")
ws.tiled_layout="lua:omacast-focus"
hl.dispatch=function() return {ok=false,error="native broke"} end
rejected(function() W.act("left-half",t) end,"native broke")
`))

test('asymmetric three-level geometry and overflow retain complete nonoverlapping coverage', () => lua(`
spec.weights={60,40}; spec.cells={{{weight=40,parts={25,75}},60},{100}}; spec.fill="order"; spec.overflow="first"
W.configure(config); recalc(); eq(ta.box.w,174); eq(tb.box.w,522); eq(tc.box.h,516)
local d=win(4); ctx.targets[#ctx.targets+1]=target(d); recalc()
local e=win(5); ctx.targets[#ctx.targets+1]=target(e); recalc()
for _,t in ipairs(ctx.targets) do assert(t.box.w>0 and t.box.h>0); assert(t.box.x>=20 and t.box.x+t.box.w<=1180) end
`))

test('owned monitor assignments release safely, register once across reload, and disable rejects', () => lua(`
config.workspaces={}; config.monitors={["desc:Panel B"]="focus"}; W.configure(config)
eq(ws.tiled_layout,"dwindle"); eq(ws2.tiled_layout,"lua:omacast-focus")
local count=#rules; dofile(BACKEND).configure(config); eq(#rules,count)
ws2.tiled_layout="scrolling"; config.enabled=false; W.configure(config); eq(ws2.tiled_layout,"scrolling")
rejected(function() W.act("left-half",frozen(a)) end,"disabled")
`))

test('all fixed frame commands, fullscreen and workspace navigation use public actions', () => lua(`
local actions={"left-half","right-half","top-half","bottom-half","top-left-quarter","top-right-quarter","bottom-left-quarter","bottom-right-quarter","first-three-fourths","last-three-fourths","first-third","center-third","last-third","first-two-thirds","last-two-thirds","maximize","almost-maximize","reasonable-size","maximize-height","maximize-width","center","center-half","center-two-thirds","make-larger","make-smaller","move-left","move-right","move-up","move-down"}
for _,id in ipairs(actions) do assert(W.act(id,frozen(a))) end
assert(W.act("toggle-fullscreen",frozen(a))); eq(a.fullscreen,2)
assert(W.act("toggle-fullscreen",frozen(a))); eq(a.fullscreen,0)
assert(W.act("next-space",nil)); eq(activews.id,12)
assert(W.act("previous-space",nil)); eq(activews.id,11)
`))

test('first ownership adopts exact existing geometry and native hex identities', () => lua(`
W.sessions={}; W.restore={}; W=dofile(BACKEND)
a.stable_id=0x1800001b
ta.box={x=890,y=30,w=290,h=860}; tb.box={x=310,y=30,w=580,h=860}; tc.box={x=20,y=30,w=290,h=860}
W.configure(config); recalc(); eq(ta.box.x,890); eq(tb.box.x,310); eq(tc.box.x,20)
W.act("place-left",{address=a.address,stableId="1800001b",workspace="11"}); eq(ta.box.x,20); eq(tb.box.x,310)
`))

test('layout messages, rows, variable areas and below targeting execute callbacks', () => lua(`
spec.orientation="rows"; spec.weights={50,50}; spec.cells={{100},{100}}; spec.fill="order"
ctx.targets={ta,tb}; c.mapped=false
ctx.area={x=-1600,y=40,w=1600,h=960}; W.configure(config); recalc()
eq(ta.box.y,40); eq(tb.box.y,520)
providers["omacast-focus"].layout_msg(ctx,"place-down"); eq(ta.box.y,520); eq(tb.box.y,40)
rejected(function() W.act("place-down",frozen(a)) end,"no slot below")
ctx.area={x=-1200,y=20,w=1200,h=800}; recalc(); eq(ta.box.y,420); eq(ta.box.w,1200)
`))

test('closed Restore identity is not transferred to a recycled address', () => lua(`
W.act("left-half",frozen(a))
local old=frozen(a); a.mapped=false
local replacement=win(44); replacement.address=old.address; active=replacement
rejected(function() W.act("restore",old) end,"reused")
rejected(function() W.act("restore",{address=replacement.address,stableId="2c",workspace="11"}) end,"no Restore")
`))

test('invalid config and unknown custom size reject before mutation', () => lua(`
local count=#rules
config.customSizes={{id="bad",width="0%",height="10",anchor="center"}}
rejected(function() W.configure(config) end,"invalid custom")
eq(#rules,count)
config.customSizes={}
rejected(function() W.act("custom:missing",frozen(a)) end,"no longer exists")
eq(a.floating,false)
`))

test('grid presets, monitor removal events and fullscreen Restore retain semantic state', () => lua(`
spec.kind="grid"; spec.gridColumns=2; spec.weights={50,50}; spec.cells={{100},{100}}
W.configure(config); recalc()
eq(ta.box.w,580); eq(tb.box.x,600); eq(tc.box.w,1160)
config.workspaces={}; config.monitors={["desc:Panel B"]="focus"}; W.configure(config)
eq(ws2.tiled_layout,"lua:omacast-focus")
ws2.monitor=nil; monitors={m1}; events["monitor.removed"]()
eq(ws2.tiled_layout,"dwindle")
config.monitors={}; config.workspaces={["11"]="focus"}; W.configure(config); recalc()
W.act("toggle-fullscreen",frozen(a)); eq(a.fullscreen,2)
W.act("restore",frozen(a)); eq(a.fullscreen,0); eq(a.floating,false)
`))

test('automatic grid columns accept canonical zero and reject invalid values', () => lua(`
spec.kind="grid"; spec.gridColumns=0; W.configure(config); recalc()
eq(ta.box.w,580); eq(tc.box.w,1160)
for _,bad in ipairs({-1,1.5,"0",false}) do
 spec.gridColumns=bad
 rejected(function() W.configure(config) end,"invalid grid column count")
end
`))

test('selector rules update in place across preset switches, disable and re-enable', () => lua(`
local handle=ruleRecords["11"]
local other={id="even",kind="ratio",orientation="columns",weights={50,50},cells={{100},{100}},fill="order",underfill="rescale",overflow="last",gridColumns=0}
config.layouts={spec,other}; config.workspaces["11"]="even"; W.configure(config)
eq(ruleRecords["11"],handle); eq(handle:is_enabled(),true); eq(ws.tiled_layout,"lua:omacast-even")
config.enabled=false; W.configure(config)
eq(ruleRecords["11"],handle); eq(handle:is_enabled(),true); eq(ws.tiled_layout,"dwindle")
config.enabled=true; config.workspaces["11"]="focus"; W.configure(config); recalc()
eq(ruleRecords["11"],handle); eq(handle:is_enabled(),true); eq(ws.tiled_layout,"lua:omacast-focus")
W.act("place-right",frozen(a)); eq(ta.box.x,890)
-- Another controller updates the same selector, aliasing our original handle.
local foreign=hl.workspace_rule({workspace="11",layout="scrolling"}); eq(foreign,handle)
config.enabled=false; W.configure(config)
eq(foreign:is_enabled(),true); eq(ws.tiled_layout,"scrolling")
`))

test('reload cannot capture an OmaCast layout as its own release fallback', () => lua(`
eq(ws.tiled_layout,"lua:omacast-focus")
W.owned={}; W.contexts={}; W.sessions={}
W=dofile(BACKEND); W.configure(config)
eq(W.owned["11"].previous,"dwindle")
config.enabled=false; W.configure(config)
eq(ws.tiled_layout,"dwindle"); eq(ruleRecords["11"]:is_enabled(),true)
`))

test('detached floating tab cannot steal surviving group Restore baseline', () => lua(`
local d,e=win(4),win(5)
a.group={members={a,d,e},current=a}; d.group=a.group; e.group=a.group
a.floating=true; d.floating=true; e.floating=true
ctx.targets={tb,tc}; recalc()
a.at={x=100,y=100}; a.size={width=400,height=300}
W.act("center",frozen(a))
a.group=nil; d.group.members={d,e}; d.group.current=d
rejected(function() W.act("restore",frozen(a)) end,"no Restore")
W.act("restore",frozen(d))
eq(d.floating,true); eq(d.at.x,100); eq(d.at.y,100); eq(d.size.width,400); eq(d.size.height,300)
rejected(function() W.act("restore",frozen(e)) end,"no Restore")
`))

test('floating group snaps reserve native configured header extents and Restore keeps body baseline', () => lua(`
local d=win(4); a.group={members={a,d},current=a}; d.group=a.group
nativeConfig["group.groupbar.enabled"]=true
nativeConfig["group.groupbar.disable_when_only"]=true
nativeConfig["group.groupbar.height"]=20
nativeConfig["group.groupbar.indicator_height"]=3
nativeConfig["group.groupbar.indicator_gap"]=3
nativeConfig["group.groupbar.gaps_out"]=2
nativeConfig["group.groupbar.keep_upper_gap"]=false
nativeConfig["group.groupbar.render_titles"]=true
nativeConfig["group.groupbar.gradients"]=false
nativeConfig["group.groupbar.stacked"]=false
a.floating=true; ctx.targets={tb,tc}; recalc()
a.at={x=100,y=100}; a.size={width=400,height=300}
W.act("left-half",frozen(a))
eq(a.at.y,58); eq(a.size.height,832)
eq(a.at.y-28,30); eq(a.at.y+a.size.height,890)
W.act("restore",frozen(a)); eq(a.at.y,100); eq(a.size.height,300)
nativeConfig["group.groupbar.stacked"]=true
nativeConfig["group.groupbar.keep_upper_gap"]=true
W.act("top-right-quarter",frozen(a))
eq(a.at.y,88); eq(a.size.height,372); eq(a.at.y-58,30)
W.act("left-half",frozen(a)); eq(a.at.y,88); eq(a.size.height,802)
W.act("next-display",frozen(a)); eq(a.workspace,ws2)
W.act("left-half",frozen(a)); eq(a.at.y,98); eq(a.size.height,702)
nativeConfig["group.groupbar.enabled"]=false
W.act("left-half",frozen(a)); eq(a.at.y,40); eq(a.size.height,760)
`))

test('session cache preserves sparse group slots through VM and target reconstruction, never recycled identities', () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'omacast-slots-'))
  fs.mkdirSync(path.join(runtime, 'hypr', 'test-instance'), { recursive: true })
  try {
    lua(`
local d=win(4); c.group={members={c,d},current=c}; d.group=c.group
b.mapped=false; ctx.targets={ta,tc}; recalc()
W.act("place-right",frozen(c)); eq(ta.box.x,310); eq(tc.box.x,890)
local cache=os.getenv("XDG_RUNTIME_DIR").."/hypr/test-instance/omacast-window-slots"
local before=assert(io.open(cache,"rb")); local bytes=before:read("*a"); before:close()
local realOpen=io.open; local writes=0
io.open=function(name,mode) if mode=="wb" then writes=writes+1 end; return realOpen(name,mode) end
recalc(); recalc(); eq(writes,0)
io.open=realOpen
-- Native config reload destroys globals/providers and transiently reports a
-- different layout while rebuilding the same surviving window targets.
_G.OmacastWindows=nil; providers={}; ws.tiled_layout="scrolling"
ta,tc=target(a),target(c); ctx.targets={ta}
W=dofile(BACKEND); W.configure(config); recalc()
ctx.targets={ta,tc}; recalc()
eq(W.owned["11"].previous,"dwindle"); eq(ta.box.x,310); eq(tc.box.x,890)
local after=assert(io.open(cache,"rb")); eq(after:read("*a"),bytes); after:close()
-- Same address, new stable identity and no surviving group member: no slot
-- inheritance. Default fill goes to the empty left slot, not saved right.
c.stable_id=99; d.mapped=false; c.group=nil
_G.OmacastWindows=nil; providers={}; ws.tiled_layout="scrolling"
ta,tc=target(a),target(c); ctx.targets={ta,tc}
W=dofile(BACKEND); W.configure(config); recalc()
eq(ta.box.x,310); eq(tc.box.x,20)
config.enabled=false; W.configure(config)
local absent=io.open(cache,"rb"); eq(absent,nil)
`, { XDG_RUNTIME_DIR: runtime, HYPRLAND_INSTANCE_SIGNATURE: 'test-instance' })
  } finally {
    fs.rmSync(runtime, { recursive: true, force: true })
  }
})

test('malformed cache is rejected as data, never executed or silently adopted', () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'omacast-slots-invalid-'))
  fs.mkdirSync(path.join(runtime, 'hypr', 'test-instance'), { recursive: true })
  try {
    lua(`
local cache=os.getenv("XDG_RUNTIME_DIR").."/hypr/test-instance/omacast-window-slots"
local f=assert(io.open(cache,"wb")); local tab,nl=string.char(9),string.char(10)
f:write("OmacastSlots1"..tab.."test-instance"..nl..table.concat({"S","zz","bad","3","1"},tab)..nl); f:close()
_G.OmacastWindows=nil; providers={}
W=dofile(BACKEND)
rejected(function() W.configure(config) end,"invalid")
`, { XDG_RUNTIME_DIR: runtime, HYPRLAND_INSTANCE_SIGNATURE: 'test-instance' })
  } finally {
    fs.rmSync(runtime, { recursive: true, force: true })
  }
})

test('official keybinding-parser callable hl stubs cannot touch the inherited compositor cache', () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'omacast-parser-'))
  fs.mkdirSync(path.join(runtime, 'hypr', 'test-instance'), { recursive: true })
  try {
    lua(`
local cache=os.getenv("XDG_RUNTIME_DIR").."/hypr/test-instance/omacast-window-slots"
local f=assert(io.open(cache,"rb")); local original=f:read("*a"); f:close()
local open,remove,rename=io.open,os.remove,os.rename
local fileCalls,stubCalls=0,0
io.open=function(...) fileCalls=fileCalls+1; return open(...) end
os.remove=function(...) fileCalls=fileCalls+1; return remove(...) end
os.rename=function(...) fileCalls=fileCalls+1; return rename(...) end
-- /usr/share/omarchy/bin/omarchy-menu-keybindings uses this callable-table
-- fallback for every missing hl API, with get_config explicitly returning nil.
local noop
noop=setmetatable({},{
 __index=function() return noop end,
 __call=function() stubCalls=stubCalls+1; return noop end,
 __len=function() return 0 end
})
local rawIpairs=ipairs
ipairs=function(list)
 if rawequal(list,noop) then return function() end,list,0 end
 return rawIpairs(list)
end
hl=setmetatable({get_config=function() return nil end},{__index=function() return noop end})
_G.OmacastWindows=nil
local parserModule=dofile(BACKEND)
eq(parserModule.configure({enabled=true,layouts=config.layouts,workspaces={},monitors={},customSizes={}}),false)
eq(parserModule.configure({enabled=false}),false)
rejected(function() parserModule.act("place-right",nil) end,"native Hyprland Lua API")
eq(fileCalls,0); eq(stubCalls,0)
io.open,os.remove,os.rename=open,remove,rename
f=assert(io.open(cache,"rb")); eq(f:read("*a"),original); f:close()
`, { XDG_RUNTIME_DIR: runtime, HYPRLAND_INSTANCE_SIGNATURE: 'test-instance' })
  } finally {
    fs.rmSync(runtime, { recursive: true, force: true })
  }
})
