-- OmaCast native window commands. Geometry adapted from bjarneo/omarchy-workspace-layout
-- Model.LUA_RUNTIME, copyright (c) 2026 Bjarne Oeverli, MIT (see NOTICE).
-- Native API: Hyprland efb50993780079460b0cbed1363e2166a2de1d9f.
local W = _G.OmacastWindows or { registered = {}, owned = {}, sessions = {}, serial = 0, restore = {} }
_G.OmacastWindows = W
-- Omarchy's keybinding scanner executes user config in standalone Lua with
-- callable-table hl stubs and the real compositor environment inherited.
-- Require the actual API shape before registering anything or touching cache.
local compositorApi=type(hl)=="table" and type(hl.get_windows)=="function"
  and type(hl.get_workspaces)=="function" and type(hl.workspace_rule)=="function"
  and type(hl.layout)=="table" and type(hl.layout.register)=="function"
local function fail(message) error("OmaCast: " .. message, 0) end
local function key(ws)
  if not ws then return nil end
  if ws.id < 0 then return "name:" .. ws.name end
  return tostring(ws.id)
end
local function sid(w) return w and w.stable_id and string.format("%x",w.stable_id) end
local function copy(a) local b = {}; for k,v in pairs(a) do b[k]=v end; return b end
local function frame(w)
  return {x=w.at.x or w.at[1], y=w.at.y or w.at[2], w=w.size.width or w.size.x or w.size[1], h=w.size.height or w.size.y or w.size[2]}
end
local function same(a,b)
  return a and b and math.abs(a.x-b.x)<2 and math.abs(a.y-b.y)<2 and math.abs(a.w-b.w)<2 and math.abs(a.h-b.h)<2
end
local function dispatch(fn, args)
  local result = hl.dispatch(fn(args))
  if type(result)~="table" or result.ok~=true then fail(type(result)=="table" and result.error or "native dispatcher rejected the command") end
end
local function usable(m)
  if not m or not m.name then fail("target monitor is unavailable") end
  local width,height = m.width,m.height
  if (m.transform or 0)%2 == 1 then width,height=height,width end
  local r=m.reserved or {}; local scale=m.scale or 1
  local a={x=m.x+(r.left or 0), y=m.y+(r.top or 0), w=width/scale-(r.left or 0)-(r.right or 0), h=height/scale-(r.top or 0)-(r.bottom or 0)}
  if a.w<=0 or a.h<=0 then fail("monitor has no usable area") end
  return a
end
local function bounded(f,a)
  local r=copy(f); r.w=math.min(a.w,math.max(1,r.w)); r.h=math.min(a.h,math.max(1,r.h))
  r.x=math.max(a.x,math.min(a.x+a.w-r.w,r.x)); r.y=math.max(a.y,math.min(a.y+a.h-r.h,r.y))
  for k,v in pairs(r) do r[k]=math.floor(v+0.5) end
  return r
end
local function group_top(w)
  if not w.group then return 0 end
  local function flag(name)
    local v=hl.get_config("group.groupbar."..name)
    if type(v)=="boolean" then return v end
    if type(v)=="number" then return v~=0 end
    fail("cannot read native groupbar setting "..name)
  end
  if not flag("enabled") then return 0 end
  local members=#w.group.members
  if members<=1 and flag("disable_when_only") then return 0 end
  local function number(name)
    local v=hl.get_config("group.groupbar."..name)
    if type(v)~="number" or v~=v or v<0 or v==math.huge then fail("invalid native groupbar setting "..name) end
    return v
  end
  -- CHyprGroupBarDecoration::getPositioningInfo at the pinned native revision.
  -- These are logical pixels; monitor scale is applied only during rendering.
  local gap=number("gaps_out")
  local one=gap+number("indicator_height")+number("indicator_gap")
  if flag("gradients") or flag("render_titles") then one=one+number("height") end
  local upper=flag("keep_upper_gap") and gap or 0
  return (flag("stacked") and one*members or one)+upper
end
local function outer_frame(w)
  local f=frame(w); local top=group_top(w)
  f.y=f.y-top; f.h=f.h+top
  return f
end
local function body_area(w,a)
  local b=copy(a); local top=group_top(w)
  b.y=b.y+top; b.h=b.h-top
  if b.h<1 then fail("group decoration exceeds usable monitor height") end
  return b
end

local function normalize(weights)
  local total = 0
  for i = 1, #weights do total = total + weights[i] end
  local out = {}
  if total <= 0 then
    for i = 1, #weights do out[i] = 100 / #weights end
    return out
  end
  for i = 1, #weights do out[i] = weights[i] * 100 / total end
  return out
end

-- A part is either a plain cross weight or a table saying how wide it is and
-- how it is cut along the grain again.
local function part_weight(part)
  if type(part) == "table" then return part.weight end
  return part
end

local function part_split(part)
  if type(part) == "table" and part.parts then return part.parts end
  return {}
end

local function part_pieces(part)
  local split = part_split(part)
  if #split > 1 then return #split end
  return 1
end

-- Even parts for a slot: what overflow stacking falls back to when it adds
-- parts to a slot whose ratio was drawn for fewer of them.
local function even_cell(count)
  local out = {}
  for i = 1, count do out[i] = 100 / count end
  return out
end

local function orient(orientation, main_offset, main_size, cross_offset, cross_size)
  if orientation == "rows" then
    return { cross_offset, main_offset, cross_size, main_size }
  end
  return { main_offset, cross_offset, main_size, cross_size }
end

local function grid_rects(spec, n)
  local columns
  if spec.grid_columns and spec.grid_columns > 0 then
    columns = math.min(spec.grid_columns, n)
  else
    columns = math.ceil(math.sqrt(n))
  end
  local rows = math.ceil(n / columns)
  local rects = {}
  for row = 0, rows - 1 do
    local first = row * columns
    local in_row = math.min(columns, n - first)
    for col = 0, in_row - 1 do
      local right = (col == in_row - 1) and 1 or (col + 1) / in_row
      local bottom = (row == rows - 1) and 1 or (row + 1) / rows
      rects[#rects + 1] = { col / in_row, row / rows, right - col / in_row, bottom - row / rows }
    end
  end
  return rects
end

-- Widest slot first, so the first window lands in the main area rather than
-- in a sliver at the edge. Ties keep positional order. table.sort is not
-- stable in Lua, hence the explicit index tiebreak.
local function fill_order(weights)
  local index = {}
  for i = 1, #weights do index[i] = i end
  table.sort(index, function(a, b)
    if weights[a] ~= weights[b] then return weights[a] > weights[b] end
    return a < b
  end)
  return index
end

local function ratio_rects(spec, n)
  local weights = spec.weights
  local counts = spec.cells
  local k = #weights
  local primary, subs = {}, {}
  local base = 0
  for i = 1, k do
    for j = 1, #counts[i] do base = base + part_pieces(counts[i][j]) end
  end
  -- A layout with a split slot was drawn in two dimensions and holds: there
  -- is no sensible way to grow one of its halves into the missing window.
  local split = base > k

  if n <= base and (spec.underfill == "hold" or split) then
    for i = 1, k do primary[i] = weights[i]; subs[i] = counts[i] end
  elseif n <= base then
    local chosen = {}
    local priority = fill_order(weights)
    for i = 1, n do chosen[i] = priority[i] end
    table.sort(chosen)
    for i = 1, n do primary[i] = weights[chosen[i]]; subs[i] = { 100 } end
  elseif spec.overflow == "extend" then
    for i = 1, k do primary[i] = weights[i]; subs[i] = counts[i] end
    local grown = base
    while grown < n do
      primary[#primary + 1] = weights[k]
      subs[#subs + 1] = { 100 }
      grown = grown + 1
    end
  else
    for i = 1, k do primary[i] = weights[i]; subs[i] = counts[i] end
    local at = (spec.overflow == "first") and 1 or k
    local held = 0
    for i = 1, #subs[at] do held = held + part_pieces(subs[at][i]) end
    subs[at] = even_cell(held + n - base)
  end

  primary = normalize(primary)

  local cells, cell_slot = {}, {}
  local offset = 0
  for slot = 1, #primary do
    local size = primary[slot] / 100
    if slot == #primary then size = 1 - offset end
    local list = subs[slot]
    local weights_of = {}
    for s = 1, #list do weights_of[s] = part_weight(list[s]) end
    local parts = normalize(weights_of)
    local crossed = 0
    for s = 1, #parts do
      local sub_size = parts[s] / 100
      if s == #parts then sub_size = 1 - crossed end
      local split = part_split(list[s])
      if #split > 1 then
        -- The part is cut again, back along the grain.
        local inner = normalize(split)
        local run = 0
        for q = 1, #inner do
          local inner_size = size * inner[q] / 100
          if q == #inner then inner_size = size - run end
          cells[#cells + 1] = orient(spec.orientation, offset + run, inner_size, crossed, sub_size)
          cell_slot[#cell_slot + 1] = slot
          run = run + inner_size
        end
      else
        cells[#cells + 1] = orient(spec.orientation, offset, size, crossed, sub_size)
        cell_slot[#cell_slot + 1] = slot
      end
      crossed = crossed + sub_size
    end
    offset = offset + size
  end

  local order
  if spec.fill == "order" then
    order = {}
    for i = 1, #primary do order[i] = i end
  else
    order = fill_order(primary)
  end

  local rects = {}
  for i = 1, #order do
    for c = 1, #cells do
      if cell_slot[c] == order[i] then rects[#rects + 1] = cells[c] end
    end
  end
  -- Under "hold" there are more cells than windows; the surplus are the
  -- empty slots, and they are last because the list is in fill order.
  while #rects > n do table.remove(rects) end
  return rects
end

function W.rects(spec, n)
  if n <= 0 then return {} end
  if spec.kind == "grid" then return grid_rects(spec, n) end
  return ratio_rects(spec, n)
end
-- Config reload destroys the Lua VM and temporarily reconstructs native targets.
-- Keep only non-executable slot data in the compositor's existing runtime dir;
-- a different instance signature can never reuse these stable window IDs.
local runtime=os.getenv("XDG_RUNTIME_DIR")
local instance=os.getenv("HYPRLAND_INSTANCE_SIGNATURE")
local cachePath
if compositorApi and runtime and runtime~="" and instance and instance:match("^[%w_.%-]+$") then
  cachePath=runtime.."/hypr/"..instance.."/omacast-window-slots"
end
local function hex(value)
  return (value:gsub(".",function(c) return string.format("%02x",string.byte(c)) end))
end
local function unhex(value)
  if #value%2~=0 or value:find("[^0-9a-f]") then fail("invalid session slot cache encoding") end
  return (value:gsub("..",function(c) return string.char(tonumber(c,16)) end))
end
local function save_slots()
  if not cachePath or not W.config.enabled then return end
  local lines={}
  local live={}
  for _,w in ipairs(hl.get_windows()) do if w.mapped then live[sid(w)]=w end end
  for selector,owned in pairs(W.owned) do
    lines[#lines+1]="P\t"..hex(selector).."\t"..hex(owned.previous)
  end
  for _,s in pairs(W.sessions) do
    if s.slot and s.layout and W.specs[s.layout] then
      local ids={}
      for id in pairs(s.ids) do
        local w=live[id]
        if w and not w.floating and key(w.workspace)==s.workspace then ids[#ids+1]=id end
      end
      table.sort(ids)
      if #ids>0 then lines[#lines+1]="S\t"..hex(s.workspace).."\t"..hex(s.layout).."\t"..s.slot.."\t"..table.concat(ids,",") end
    end
  end
  table.sort(lines)
  local data="OmacastSlots1\t"..instance.."\n"..table.concat(lines,"\n").."\n"
  if #data>262144 then fail("session slot cache exceeds its size bound") end
  if W.cachedData==data then return end
  local file,err=io.open(cachePath..".tmp","wb")
  if not file then fail("cannot save session slots: "..tostring(err)) end
  local ok,writeError=file:write(data); local closed,closeError=file:close()
  if not ok or not closed then os.remove(cachePath..".tmp"); fail("cannot save session slots: "..tostring(writeError or closeError)) end
  local renamed,renameError=os.rename(cachePath..".tmp",cachePath)
  if not renamed then os.remove(cachePath..".tmp"); fail("cannot replace session slots: "..tostring(renameError)) end
  W.cachedData=data
end
local function load_slots()
  if W.cacheLoaded then return end
  if not cachePath then W.cacheLoaded=true; W.previous={}; return end
  local file,err,code=io.open(cachePath,"rb")
  if not file then if code==2 then W.cacheLoaded=true; W.previous={}; return end; fail("cannot read session slots: "..tostring(err)) end
  local data=file:read(262145); file:close()
  if type(data)~="string" or #data>262144 or data:sub(1,#("OmacastSlots1\t"..instance.."\n"))~="OmacastSlots1\t"..instance.."\n" then fail("invalid compositor session slot cache") end
  local live={}
  for _,w in ipairs(hl.get_windows()) do if w.mapped then live[sid(w)]=w end end
  local count=0; local loadSessions=next(W.sessions)==nil
  local seenIds,seenSlots={},{}
  local previousLayouts,loadedSessions={},{}
  for line in data:gmatch("[^\n]+") do
    if line:sub(1,2)=="P\t" then
      local ws,previous=line:match("^P\t([0-9a-f]+)\t([0-9a-f]+)$")
      if not ws then fail("invalid session layout fallback") end
      ws,previous=unhex(ws),unhex(previous)
      if previous:match("^lua:omacast%-") then fail("owned layout cannot be its own fallback") end
      if previousLayouts[ws] then fail("duplicate session layout fallback") end
      previousLayouts[ws]=previous
    elseif line:sub(1,2)=="S\t" then
      local ws,layout,slot,members=line:match("^S\t([0-9a-f]+)\t([0-9a-f]+)\t(%d+)\t([0-9a-f,]+)$")
      if not ws then fail("invalid session slot record") end
      ws,layout,slot=unhex(ws),unhex(layout),tonumber(slot)
      if slot<1 or slot>32768 then fail("invalid session slot number") end
      if members:sub(1,1)=="," or members:sub(-1)=="," or members:find(",,",1,true) or #members>8192 then fail("invalid session group identities") end
      local location=hex(ws)..":"..hex(layout)..":"..slot
      if seenSlots[location] then fail("duplicate session slot") end
      seenSlots[location]=true
      local ids,window={},nil
      for id in members:gmatch("[^,]+") do
        if #id>16 or seenIds[id] then fail("duplicate or invalid session identity") end
        seenIds[id]=true
        local w=live[id]
        if w and not w.floating and key(w.workspace)==ws then ids[id]=true; window=w end
      end
      if loadSessions and window and W.specs[layout] then
        loadedSessions[#loadedSessions+1]={ids=ids,window=window,workspace=ws,layout=layout,slot=slot}
      end
    elseif line~="OmacastSlots1\t"..instance then fail("unknown session slot record") end
    count=count+1; if count>4096 then fail("too many session slot records") end
  end
  for _,s in ipairs(loadedSessions) do W.serial=W.serial+1; W.sessions[W.serial]=s end
  W.previous=previousLayouts; W.cacheLoaded=true
  W.cachedData=data
end


-- Reconcile all targets together: the surviving group claims its old token before
-- a detached tab can. A token is never keyed by the currently selected tab.
local function reconcile(ctx)
  local entries = {}
  for _,t in ipairs(ctx.targets) do
    local w=t.window
    if w and w.mapped then
      local ids={}
      for _,m in ipairs(w.group and w.group.members or {w}) do ids[sid(m)]=true end
      entries[#entries+1]={target=t, window=w, ids=ids, grouped=w.group~=nil}
    end
  end
  table.sort(entries,function(a,b)
    if a.grouped~=b.grouped then return a.grouped end
    return sid(a.window)<sid(b.window)
  end)
  local claimed={}
  for _,e in ipairs(entries) do
    local best,score
    for token,s in pairs(W.sessions) do
      if not claimed[token] and s.workspace==key(e.window.workspace) then
        local overlap=0
        for id in pairs(e.ids) do if s.ids[id] then overlap=overlap+1 end end
        if overlap>0 and (not score or overlap>score or (overlap==score and token<best)) then best,score=token,overlap end
      end
    end
    if not best then W.serial=W.serial+1; best=W.serial; W.sessions[best]={} end
    local s=W.sessions[best]
    s.ids=e.ids; s.workspace=key(e.window.workspace); s.window=e.window
    e.token=best; e.session=s; claimed[best]=true
  end
  local live,assigned={},{}
  for _,w in ipairs(hl.get_windows()) do if w.mapped then live[sid(w)]=true end end
  for _,e in ipairs(entries) do for id in pairs(e.ids) do assigned[id]=true end end
  for token,s in pairs(W.sessions) do
    local alive,merged=false,false
    for id in pairs(s.ids) do
      if live[id] then alive=true end
      if assigned[id] and not claimed[token] then merged=true end
    end
    if not alive or merged then W.sessions[token]=nil; W.restore[token]=nil end
  end
  return entries
end
local function layout_place(id,ctx)
  local spec=W.specs[id]
  if not spec then fail("layout preset no longer exists") end
  local entries=reconcile(ctx)
  local count=#entries
  if count==0 then return entries,{} end
  local base=0
  for _,cell in ipairs(spec.cells or {}) do for _,part in ipairs(cell) do base=base+part_pieces(part) end end
  local held=spec.underfill=="hold" or base>#spec.weights
  if held then count=math.max(count,base) end
  local pending=0
  local workspace=key(entries[1].window.workspace)
  for _,s in pairs(W.sessions) do
    local w=s.window
    if s.layout==id and s.workspace==workspace and w and w.mapped and not w.floating and key(w.workspace)==workspace then
      pending=pending+1
      if held and s.slot then count=math.max(count,s.slot) end
    end
  end
  count=math.max(count,pending)
  local rects=W.rects(spec,count)
  local used={}
  for _,e in ipairs(entries) do
    local s=e.session
    if s.layout~=id or not s.slot or s.slot>#rects or used[s.slot] then s.slot=nil end
    if not s.layout and e.target.box then
      for slot,r in ipairs(rects) do
        local a=ctx.area
        local expected={x=a.x+a.w*r[1],y=a.y+a.h*r[2],w=a.w*r[3],h=a.h*r[4]}
        -- Adopt exact existing geometry at cutover; never guess from app identity.
        if not used[slot] and same(e.target.box,expected) then s.slot=slot; break end
      end
    end
    if s.slot then used[s.slot]=true end
    s.layout=id
  end
  for _,e in ipairs(entries) do
    if not e.session.slot then
      local slot=1; while used[slot] do slot=slot+1 end
      e.session.slot=slot; used[slot]=true
    end
    local r=rects[e.session.slot]; local a=ctx.area
    local x0,y0=math.floor(a.w*r[1]+0.5),math.floor(a.h*r[2]+0.5)
    local x1,y1=math.floor(a.w*(r[1]+r[3])+0.5),math.floor(a.h*(r[2]+r[4])+0.5)
    local goal={x=a.x+x0,y=a.y+y0,w=x1-x0,h=y1-y0}
    e.target:place(goal)
    if not same(e.target.box,goal) then fail("layout target did not accept placement") end
  end
  local ws=key(entries[1].window.workspace)
  W.contexts[ws]={id=id,ctx=ctx}
  save_slots()
  return entries,rects
end
local function target_window(target)
  if not target then
    local w=hl.get_active_window()
    if not w or not w.mapped then fail("no active window") end
    return w
  end
  if type(target)~="table" or type(target.address)~="string" or type(target.stableId)~="string" or target.workspace==nil then fail("invalid frozen window identity") end
  for _,w in ipairs(hl.get_windows()) do
    if w.address==target.address and sid(w)==target.stableId and w.mapped then
      if key(w.workspace)~=tostring(target.workspace) then fail("captured window changed workspace; reopen OmaCast") end
      return w
    end
  end
  fail("captured window closed or its address was reused")
end
local function entry_for(w)
  local c=W.contexts[key(w.workspace)]
  if not c or w.floating or w.workspace.tiled_layout~="lua:omacast-"..c.id then
    fail("assign an OmaCast layout to this workspace before placing tiled windows")
  end
  local entries,rects=layout_place(c.id,c.ctx)
  for _,e in ipairs(entries) do if e.ids[sid(w)] then return e,entries,rects,c end end
  fail("window has no live owned layout target")
end
local function snapshot(w,e)
  local ids={}
  for _,member in ipairs(w.group and w.group.members or {w}) do ids[sid(member)]=true end
  return {frame=frame(w),floating=w.floating,workspace=key(w.workspace),monitor=w.workspace.monitor.name,
    fullscreen=w.fullscreen or 0,slot=e and e.session.slot,layout=e and e.session.layout,ids=e and copy(e.ids) or ids}
end
local function identity(w)
  local ids,live={},{}
  for _,member in ipairs(w.group and w.group.members or {w}) do ids[sid(member)]=true end
  for _,member in ipairs(hl.get_windows()) do if member.mapped then live[sid(member)]=member end end
  local best,score
  for token,s in pairs(W.sessions) do
    local overlap,alive=0,false
    local survivor,survivorCount,survivorAnchor
    for id in pairs(s.ids) do
      local member=live[id]
      if member then
        alive=true
        local count,anchor=0,false
        for _,peer in ipairs(member.group and member.group.members or {member}) do
          if s.ids[sid(peer)] then count=count+1 end
          if s.window and sid(peer)==sid(s.window) then anchor=true end
        end
        if not survivor or count>survivorCount or
          (count==survivorCount and anchor and not survivorAnchor) or
          (count==survivorCount and anchor==survivorAnchor and id<survivor) then
          survivor,survivorCount,survivorAnchor=id,count,anchor
        end
      end
      if ids[id] then overlap=overlap+1 end
    end
    if not alive then W.sessions[token]=nil; W.restore[token]=nil
    -- Reserve the original token for the largest surviving membership, even
    -- when a detached floating tab invokes Restore before any tiled callback.
    elseif survivor and ids[survivor] and overlap>0 and (not score or overlap>score or (overlap==score and token<best)) then best,score=token,overlap end
  end
  if not best then W.serial=W.serial+1; best=W.serial; W.sessions[best]={workspace=key(w.workspace)} end
  local s=W.sessions[best]; s.ids=ids; s.window=w
  return best,s
end
local function remember(w,e)
  local owned=W.contexts[key(w.workspace)]
  if not e and not w.floating and owned and w.workspace.tiled_layout=="lua:omacast-"..owned.id then e=entry_for(w) end
  local token= e and e.token or identity(w)
  local prior=W.restore[token]
  if not prior or (w.floating and prior.last and not same(frame(w),prior.last)) then
    W.restore[token]=snapshot(w,e)
    local count,oldest=0,nil
    for id in pairs(W.restore) do count=count+1; if not oldest or id<oldest then oldest=id end end
    if count>128 then W.restore[oldest]=nil end
  end
  return token
end
local function place_action(action,w)
  local e,entries,rects,c=entry_for(w)
  local from=e.session.slot; local f=rects[from]; local chosen,score
  for i,r in ipairs(rects) do
    local cx,cy=r[1]+r[3]/2,r[2]+r[4]/2
    local value
    if action=="place-left" then value=cx*1000+math.abs(cy-(f[2]+f[4]/2))
    elseif action=="place-right" then value=-cx*1000+math.abs(cy-(f[2]+f[4]/2))
    elseif action=="place-center" then value=math.abs(cx-0.5)*1000+math.abs(cy-(f[2]+f[4]/2))
    elseif cy>f[2]+f[4]/2+0.0001 then
      local overlap=math.min(r[1]+r[3],f[1]+f[3])-math.max(r[1],f[1])
      if overlap>0 then value=(cy-f[2]-f[4]/2)*1000+math.abs(cx-f[1]-f[3]/2) end
    end
    if value and (not score or value<score) then chosen,score=i,value end
  end
  if not chosen then fail("no slot below this window") end
  if chosen==from then return true end
  remember(w,e)
  for _,other in ipairs(entries) do if other.session.slot==chosen then other.session.slot=from end end
  e.session.slot=chosen
  layout_place(c.id,c.ctx)
  if e.session.slot~=chosen then fail("layout placement was not retained") end
  return true
end
local function apply_frame(w,f)
  if (w.fullscreen or 0)~=0 then dispatch(hl.dsp.window.fullscreen,{window=w,action="unset",layout_aware=false}) end
  if not w.floating then dispatch(hl.dsp.window.float,{window=w,action="enable"}) end
  if not w.floating then fail("window did not enter floating mode") end
  dispatch(hl.dsp.window.resize,{window=w,x=f.w,y=f.h,relative=false})
  dispatch(hl.dsp.window.move,{window=w,x=f.x,y=f.y,relative=false})
  if not same(frame(w),f) then fail("window constraints prevented requested frame") end
end
local function apply_outer_frame(w,f)
  local body=copy(f); local top=group_top(w)
  body.y=body.y+top; body.h=body.h-top
  if body.h<1 then fail("requested frame is smaller than the native group decoration") end
  apply_frame(w,body)
end
local fractions={
  ["left-half"]={0,0,0.5,1},["right-half"]={0.5,0,0.5,1},
  ["top-half"]={0,0,1,0.5},["bottom-half"]={0,0.5,1,0.5},
  ["top-left-quarter"]={0,0,0.5,0.5},["top-right-quarter"]={0.5,0,0.5,0.5},
  ["bottom-left-quarter"]={0,0.5,0.5,0.5},["bottom-right-quarter"]={0.5,0.5,0.5,0.5},
  ["first-three-fourths"]={0,0,0.75,1},["last-three-fourths"]={0.25,0,0.75,1},
  ["first-third"]={0,0,1/3,1},["center-third"]={1/3,0,1/3,1},["last-third"]={2/3,0,1/3,1},
  ["first-two-thirds"]={0,0,2/3,1},["last-two-thirds"]={1/3,0,2/3,1},
  maximize={0,0,1,1},["almost-maximize"]={0.025,0.025,0.95,0.95},
  ["reasonable-size"]={0.125,0.125,0.75,0.75},["center-half"]={0.25,0,0.5,1},
  ["center-two-thirds"]={1/6,0,2/3,1}
}
local anchors={
  ["top-left"]={0,0},top={0.5,0},["top-right"]={1,0},left={0,0.5},center={0.5,0.5},right={1,0.5},
  ["bottom-left"]={0,1},bottom={0.5,1},["bottom-right"]={1,1}
}
local function dimension(value,span)
  if type(value)~="string" then fail("custom dimensions must be strings") end
  local percent=value:match("^(%d+%.?%d*)%%$")
  local n=percent and tonumber(percent)*span/100 or (value:match("^%d+%.?%d*$") and tonumber(value))
  if not n or n<=0 then fail("invalid custom size dimension") end
  return n
end
local function restore_window(w)
  local token,session=identity(w); local saved=W.restore[token]
  local retained=false
  if saved then for id in pairs(session.ids) do if saved.ids[id] then retained=true end end end
  if not retained then fail("no Restore state for this window or group") end
  local ws=hl.get_workspace(saved.workspace)
  if not ws then fail("Restore workspace no longer exists") end
  local m=hl.get_monitor(saved.monitor) or ws.monitor
  local a=usable(m)
  if not saved.floating and saved.slot then
    local c=W.contexts[saved.workspace]
    if not c or c.id~=saved.layout or ws.tiled_layout~="lua:omacast-"..saved.layout then fail("Restore layout is no longer assigned") end
  end
  if (w.fullscreen or 0)~=0 then dispatch(hl.dsp.window.fullscreen,{window=w,action="unset",layout_aware=false}) end
  if key(w.workspace)~=saved.workspace then dispatch(hl.dsp.window.move,{window=w,workspace=ws,follow=false}) end
  if key(w.workspace)~=saved.workspace then fail("Restore could not return to its workspace") end
  if saved.floating then apply_frame(w,bounded(saved.frame,body_area(w,a)))
  else
    if w.floating then dispatch(hl.dsp.window.float,{window=w,action="disable"}) end
    if w.floating then fail("Restore could not retile the window") end
    if saved.slot then
      local e,entries,_,c=entry_for(w); local from=e.session.slot
      for _,other in ipairs(entries) do if other~=e and other.session.slot==saved.slot then other.session.slot=from end end
      e.session.slot=saved.slot; layout_place(c.id,c.ctx)
    end
  end
  if saved.fullscreen~=0 then dispatch(hl.dsp.window.fullscreen,{window=w,action="set",mode=saved.fullscreen==1 and "maximized" or "fullscreen",layout_aware=false}) end
  if (w.fullscreen or 0)~=saved.fullscreen then fail("Restore could not recover fullscreen state") end
  W.restore[token]=nil
  return true
end
function W.act(action,target)
  if not compositorApi then fail("window actions require the native Hyprland Lua API") end
  if not W.config or not W.config.enabled then fail("window management is disabled") end
  if action=="previous-space" or action=="next-space" then
    local ws=target and target_window(target).workspace or hl.get_active_workspace()
    if not ws or ws.id<1 then fail("workspace navigation requires a numbered workspace") end
    local id=ws.id+(action=="next-space" and 1 or -1)
    if id<1 then fail("already at the first workspace") end
    dispatch(hl.dsp.focus,{workspace=tostring(id)})
    local active=hl.get_active_workspace()
    if not active or active.id~=id then fail("workspace did not change") end
    return true
  end
  local w=target_window(target)
  if action=="place-left" or action=="place-right" or action=="place-center" or action=="place-down" then return place_action(action,w) end
  if action=="restore" then return restore_window(w) end
  local f=outer_frame(w); local a=usable(w.workspace.monitor); local r=fractions[action]
  local custom
  if type(action)=="string" and action:sub(1,7)=="custom:" then
    for _,s in ipairs(W.config.customSizes or {}) do if s.id==action:sub(8) then custom=s end end
    if not custom then fail("custom size no longer exists") end
    local anchor=anchors[custom.anchor]
    if not anchor then fail("invalid custom size anchor") end
    local width,height=dimension(custom.width,a.w),dimension(custom.height,a.h)
    if width>a.w or height>a.h then fail("custom size exceeds the usable monitor area") end
    f={x=a.x+(a.w-width)*anchor[1]+(custom.offsetX or 0),y=a.y+(a.h-height)*anchor[2]+(custom.offsetY or 0),w=width,h=height}
  elseif r then f={x=a.x+a.w*r[1],y=a.y+a.h*r[2],w=a.w*r[3],h=a.h*r[4]}
  elseif action=="center" then f.x=a.x+(a.w-f.w)/2; f.y=a.y+(a.h-f.h)/2
  elseif action=="maximize-height" then f.y=a.y; f.h=a.h
  elseif action=="maximize-width" then f.x=a.x; f.w=a.w
  elseif action=="make-larger" or action=="make-smaller" then
    local factor=action=="make-larger" and 1.1 or 1/1.1
    local width,height=f.w*factor,f.h*factor
    f.x=f.x+(f.w-width)/2; f.y=f.y+(f.h-height)/2; f.w=width; f.h=height
  elseif action=="move-left" then f.x=f.x-40
  elseif action=="move-right" then f.x=f.x+40
  elseif action=="move-up" then f.y=f.y-40
  elseif action=="move-down" then f.y=f.y+40
  elseif action=="toggle-fullscreen" then
    local token=remember(w); local before=w.fullscreen
    dispatch(hl.dsp.window.fullscreen,{window=w,action="toggle",layout_aware=false})
    if w.fullscreen==before then fail("fullscreen state did not change") end
    W.restore[token].last=frame(w); return true
  elseif action=="next-display" or action=="previous-display" then
    local monitors=hl.get_monitors(); local index
    table.sort(monitors,function(x,y) return x.id<y.id end)
    for i,m in ipairs(monitors) do if m.name==w.workspace.monitor.name then index=i end end
    if not index or #monitors<2 then fail("no other display is available") end
    local dest=monitors[(index-1+(action=="next-display" and 1 or -1))%#monitors+1]
    local nextArea=usable(dest)
    if not dest.active_workspace then fail("destination display has no active workspace") end
    local floating=w.floating
    local saved=W.restore[remember(w)]
    if floating then f={x=nextArea.x+(f.x-a.x)/a.w*nextArea.w,y=nextArea.y+(f.y-a.y)/a.h*nextArea.h,w=f.w,h=f.h} end
    dispatch(hl.dsp.window.move,{window=w,monitor=dest,follow=false})
    if not w.workspace.monitor or w.workspace.monitor.name~=dest.name then fail("window did not reach the destination display") end
    if floating then apply_outer_frame(w,bounded(f,nextArea))
    elseif w.floating then fail("display move did not preserve the tiled window") end
    -- Native destination callbacks can replace the workspace-local layout token.
    local token,session=identity(w); local workspace=key(w.workspace)
    if session.workspace~=workspace then session.slot=nil; session.layout=nil end
    session.workspace=workspace
    saved.last=frame(w); W.restore[token]=saved
    return true
  else fail("unsupported window action: "..tostring(action)) end
  local e
  if not w.floating and W.contexts[key(w.workspace)] then e=entry_for(w) end
  local token=remember(w,e)
  apply_outer_frame(w,bounded(f,a)); W.restore[token].last=frame(w)
  return true
end
local function positive(v) return type(v)=="number" and v==v and v>0 and v<100000 end
local function validate(config)
  if type(config)~="table" then fail("invalid window management configuration") end
  local specs={}
  for _,s in ipairs(config.layouts or {}) do
    if type(s.id)~="string" or not s.id:match("^[a-z0-9][a-z0-9%-]*$") or specs[s.id] then fail("invalid or duplicate layout id") end
    if s.kind~="ratio" and s.kind~="grid" then fail("unsupported layout kind") end
    if s.orientation~="columns" and s.orientation~="rows" then fail("invalid layout orientation") end
    if s.fill~="largest" and s.fill~="order" then fail("invalid layout fill policy") end
    if s.underfill~="hold" and s.underfill~="rescale" then fail("invalid underfill policy") end
    if s.overflow~="first" and s.overflow~="last" and s.overflow~="extend" then fail("invalid overflow policy") end
    if type(s.weights)~="table" or #s.weights<1 or #s.weights>32 then fail("invalid layout weights") end
    local spec=copy(s); spec.cells={}; spec.grid_columns=s.gridColumns
    if spec.grid_columns~=nil and spec.grid_columns~=0 and (not positive(spec.grid_columns) or spec.grid_columns%1~=0) then fail("invalid grid column count") end
    for i,v in ipairs(s.weights) do
      if not positive(v) then fail("layout weights must be positive") end
      local cell=(s.cells or {})[i] or {100}
      if type(cell)~="table" or #cell<1 or #cell>32 then fail("invalid layout cell") end
      spec.cells[i]=cell
      for _,part in ipairs(cell) do
        if type(part)=="table" then
          if not positive(part.weight) or type(part.parts)~="table" or #part.parts<1 or #part.parts>32 then fail("invalid three-level layout cell") end
          for _,p in ipairs(part.parts) do if not positive(p) then fail("invalid inner cell weight") end end
        elseif not positive(part) then fail("invalid cell weight") end
      end
    end
    specs[s.id]=spec
  end
  for _,map in ipairs({config.workspaces or {},config.monitors or {}}) do
    for selector,id in pairs(map) do
      if type(selector)~="string" or not specs[id] then fail("assignment references an unknown layout") end
    end
  end
  for selector in pairs(config.monitors or {}) do
    if not selector:match("^desc:.+") and not selector:match("^name:.+") then fail("monitor selectors require desc: or name:") end
  end
  local customs={}
  for _,s in ipairs(config.customSizes or {}) do
    if type(s.id)~="string" or s.id=="" or customs[s.id] or not anchors[s.anchor] then fail("invalid custom size") end
    dimension(s.width,100); dimension(s.height,100)
    for _,offset in ipairs({s.offsetX or 0,s.offsetY or 0}) do
      if type(offset)~="number" or offset~=offset or math.abs(offset)>100000 then fail("invalid custom size offset") end
    end
    customs[s.id]=true
  end
  return specs
end
local function set_layout_rule(selector,layout)
  -- replaceOrAdd merges the existing enabled selector record in place. Old
  -- handles can alias it, so never disable a handle while replacing its layout.
  local rule=hl.workspace_rule({workspace=selector,layout=layout})
  if not rule then fail("workspace layout rule was rejected") end
  rule:set_enabled(true)
  if not rule:is_enabled() then fail("workspace layout rule did not become enabled") end
  return rule
end
local function release(selector)
  local owned=W.owned[selector]
  if not owned then return end
  local ws=hl.get_workspace(selector)
  -- Do not overwrite a controller which took over since our last assignment.
  if not ws or ws.tiled_layout==owned.layout then
    set_layout_rule(selector,owned.previous)
  end
  W.owned[selector]=nil; W.contexts[selector]=nil
end
local function assignments()
  if W.assigning then return end
  W.assigning=true
  local ok,err=pcall(function()
    local wanted={}
    if W.config.enabled then
      for _,ws in ipairs(hl.get_workspaces()) do
        local m=ws.monitor
        local id=m and ((W.config.monitors or {})["desc:"..m.description] or (W.config.monitors or {})["name:"..m.name])
        if id then wanted[key(ws)]=id end
      end
      for selector,id in pairs(W.config.workspaces or {}) do wanted[selector]=id end
    end
    local removed={}
    for selector in pairs(W.owned) do if not wanted[selector] then removed[#removed+1]=selector end end
    for _,selector in ipairs(removed) do release(selector) end
    for selector,id in pairs(wanted) do
      local name="lua:omacast-"..id; local owned=W.owned[selector]
      if not owned or owned.layout~=name then
        local previous=owned and owned.previous or (W.previous and W.previous[selector]) or hl.get_config("general.layout")
        if type(previous)=="string" and previous:match("^lua:omacast%-") then
          previous=hl.get_config("general.layout")
          if type(previous)~="string" or previous:match("^lua:omacast%-") then fail("set general.layout to a native fallback layout before assigning OmaCast") end
        end
        W.owned[selector]={previous=previous,layout=name,rule=set_layout_rule(selector,name)}
      end
    end
  end)
  W.assigning=false
  if not ok then error(err,0) end
  save_slots()
end
function W.configure(config)
  if not compositorApi then return false end
  local specs=validate(config)
  W.specs=specs; W.contexts=W.contexts or {}; W.config=config
  if config.enabled then load_slots() end
  for id in pairs(specs) do
    local name="omacast-"..id
    if not W.registered[name] then
      hl.layout.register(name,{
        recalculate=function(ctx) layout_place(id,ctx) end,
        layout_msg=function(_,message)
          if message~="place-left" and message~="place-right" and message~="place-center" and message~="place-down" then fail("unsupported layout message") end
          W.act(message,nil)
        end
      })
      W.registered[name]=true
    end
  end
  for _,sub in ipairs(W.subscriptions or {}) do sub:remove() end
  W.subscriptions={}
  if config.enabled then
    for _,event in ipairs({"workspace.created","workspace.move_to_monitor","monitor.added","monitor.removed"}) do
      W.subscriptions[#W.subscriptions+1]=hl.on(event,assignments)
    end
  end
  assignments()
  if not config.enabled then
    W.contexts={}; W.sessions={}; W.restore={}; W.cachedData=nil; W.cacheLoaded=nil; W.previous={}
    if cachePath then
      local removed,err,code=os.remove(cachePath)
      if not removed and code~=2 then fail("cannot remove session slots: "..tostring(err)) end
    end
  end
  return true
end
return W
