// Hashed query associations only. Callers supply the context digest; queries never enter this store.
var LearningApi = (function() {
  var hashPattern = /^[a-f0-9]{32}$/
  function normalize(raw, eligible) {
    var out = ({})
    Object.keys(raw || {}).filter(function(hash) { return hashPattern.test(hash) }).sort(function(a, b) {
      return newest(raw[b]) - newest(raw[a]) || a.localeCompare(b)
    }).slice(0, 200).forEach(function(hash) {
      var entries = raw[hash]
      if (!entries || typeof entries !== "object" || Array.isArray(entries)) return
      var next = ({})
      Object.keys(entries).filter(function(key) {
        var item = entries[key]
        return eligible(key) && item && Number.isInteger(item.count) && item.count > 0 && Number.isInteger(item.last) && item.last >= 0
      }).sort(function(a, b) { return entries[b].last - entries[a].last || entries[b].count - entries[a].count || a.localeCompare(b) }).slice(0, 8).forEach(function(key) {
        next[key] = { count: Math.min(entries[key].count, 1000000), last: entries[key].last }
      })
      if (Object.keys(next).length) out[hash] = next
    })
    return out
  }
  function newest(entries) {
    var last = 0
    Object.keys(entries || {}).forEach(function(key) { if (entries[key] && Number.isFinite(entries[key].last)) last = Math.max(last, entries[key].last) })
    return last
  }
  function record(raw, key, hash, now, eligible) {
    var next = normalize(raw, eligible)
    if (!eligible(key) || !hashPattern.test(String(hash || "")) || !Number.isInteger(now) || now < 0) return next
    if (!next[hash]) next[hash] = ({})
    var old = next[hash][key]
    next[hash][key] = { count: Math.min(1000000, old ? old.count + 1 : 1), last: now }
    return normalize(next, eligible)
  }
  function bonus(raw, key, hash, now) {
    if (!hashPattern.test(String(hash || ""))) return 0
    var entry = raw && raw[hash] && raw[hash][key]
    if (!entry) return 0
    var age = Math.max(0, now - entry.last)
    return Math.min(100, Math.round(20 * Math.log(1 + entry.count) / Math.LN2 / (1 + age / 604800000)))
  }
  function remove(raw, key, eligible) {
    var next = normalize(raw, eligible)
    Object.keys(next).forEach(function(hash) { delete next[hash][key]; if (!Object.keys(next[hash]).length) delete next[hash] })
    return next
  }
  return { normalize: normalize, record: record, bonus: bonus, remove: remove }
})()
if (typeof module !== "undefined") module.exports = LearningApi
