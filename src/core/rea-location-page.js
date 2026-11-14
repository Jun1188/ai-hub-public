'use strict';
// Pages refer to the retained projection of a single REA record. The provider total can be unknown.
function locationPage(evidence, offset = 0) {
  const rows = Array.isArray(evidence.locations) ? evidence.locations : [];
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > rows.length) throw new Error('rea_location_offset_invalid');
  const items = rows.slice(offset, offset + 12).map((row, index) => {
    const location = { ordinal:offset + index + 1 };
    for (const key of ['kind','symbol','name','address','offset','start','end','line','end_line']) {
      const value = row?.[key];
      if (typeof value === 'string') location[key] = value.replace(/[\r\n\t]/g, ' ').slice(0, 160);
      if (Number.isSafeInteger(value)) location[key] = value;
    }
    return location;
  });
  return { offset, items, nextOffset:offset + items.length < rows.length ? offset + items.length : null,
    storedLocations:Array.isArray(evidence.locations) ? rows.length : null, totalLocations:null };
}
module.exports = {locationPage};
