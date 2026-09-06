/**
 * Turning the price-list spreadsheet into clean catalogue rows.
 *
 * The header names and the guessing rules deliberately mirror the existing
 * Balaji Quotation Platform, so the same file that works in that tool works
 * here. What this adds is normalisation the browser tool does not do: GST is
 * written three different ways in the sheet, a third of rows have no HSN, and
 * a handful are priced at zero.
 */

/** Same header guesses the quotation tool uses, so the mapping matches. */
export const HEADER_GUESSES = {
  brand: ['brand', 'make', 'company'],
  partNo: ['part', 'code', 'item code', 'itemcode', 'cat', 'sku', 'model'],
  description: ['desc', 'description', 'product', 'item name', 'particular', 'name'],
  hsn: ['hsn', 'sac'],
  price: ['price', 'mrp', 'rate', 'list', 'basic'],
  uom: ['uom', 'unit', 'pack'],
  gst: ['gst', 'tax', 'igst'],
};

export function guessMapping(headers) {
  const mapping = {};
  for (const [field, hints] of Object.entries(HEADER_GUESSES)) {
    mapping[field] =
      headers.find((h) => hints.some((hint) => h.toLowerCase().includes(hint))) || '';
  }
  return mapping;
}

const str = (v) => (v === undefined || v === null ? '' : String(v).trim());

/** "GST 18%" -> 18, "18" -> 18, "5% GST" -> 5, "" -> null */
export function parseGst(v) {
  const m = str(v).match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

export function parsePrice(v) {
  const n = parseFloat(str(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/** HSN is 8 digits when present; anything else is treated as absent. */
export function parseHsn(v) {
  const digits = str(v).replace(/\D/g, '');
  return digits.length >= 4 ? digits : null;
}

/**
 * Category is derived, because the price list has no category column and the
 * dashboard, reorder reporting and quotation search all want one.
 *
 * Order matters: "CUT-OFF WHEEL" and "MARBLE CUTTING BLADES" are abrasives,
 * not cutting tools, so abrasives are tested first.
 */
const CATEGORY_RULES = [
  // Prefixes, not whole words: the list is full of plurals and trade
  // abbreviations ("PLIERS", "SPNR", "SC DR BITS"), so a trailing \b would
  // miss most of them.
  ['Abrasives', /(cut[- ]?off|grinding wheel|flap disc|emery|abrasive|sand ?paper|buffing|wire brush|cutting blade|cutting wheel|depressed cent|velcro disc|honing|whetstone)/i],
  ['Safety Equipment', /(helmet|safety shoe|gum ?boot|hand glove|goggle|face shield|ear ?(muff|plug)|dust mask|respirator|harness|safety belt|safety apron|hi[- ]?vis|reflective jacket)/i],
  ['Lubricants & Chemicals', /(lubricant|grease(?! ?(pump|gun))|cutting oil|spray|cleaner|thread ?lock|adhesive|sealant|anti[- ]?spatter|rust remov|solvent|coolant)/i],
  ['Measuring Instruments', /(caliper|vernier|micrometer|dial (gauge|indicator)|measuring tape|steel rule|spirit level|protractor|feeler|height gauge|bore gauge|thread gauge|try square|plumb bob|thermometer|multimeter|clamp meter|line tester|torque wrench|torque screw)/i],
  ['Welding', /(weld|electrode|\bmig\b|\btig\b|earth clamp|soldering|brazing)/i],
  ['Material Handling', /(chain pulley|hoist|wire rope|webbing sling|shackle|hydraulic jack|bottle jack|trolley|winch|crane|barrel pump|grease pump|oil pump|wheel ?barrow|lever block)/i],
  ['Cutting Tools', /(drill bit|twist drill|\bhss\b|tap and die|die nut|\btaps?\b|reamer|end mill|milling cutter|hole saw|countersink|carbide insert|[cdtw]nmg|hacksaw blade|tool bit|broach|thread cutt|masonry drill|core drill)/i],
  ['Power Tools', /(angle grinder|impact wrench|impact driver|rotary hammer|demolition|cordless|jig ?saw|circular saw|planer|router|sander|blower|heat gun|marble cutter|drill machine|polisher|vacuum|worklight|work light|\bled\b.*(light|lamp)|torch)/i],
  ['Pneumatics', /(air (blow|gun|hose|coupler|impact)|pneumatic|compressor|quick coupler)/i],
  ['Fasteners', /(\bbolts?\b|\bnuts?\b|washer|rivet|anchor fasten|self[- ]?tapping)/i],
  ['Storage & Workshop', /(tool ?(box|bag|cabinet|trolley|kit|set)|workbench|tool rack|organi[sz]er|work ?bench)/i],
  // Hand tools last and widest, because most of the catalogue is hand tools
  // and the narrower categories above should win where they apply.
  ['Hand Tools', /(spanner|spnr|\bspan\b|wrench|plier|screw ?driver|\bsc ?dr\b|\bs\.? ?d\.?\b|socket|ratchet|\btorx\b|hex key|allen|\bbits?\b|hammer|mallet|chisel|vice|vise|\bfiles?\b|hacksaw|punch|tong|crimp|cutter|snip|shear|scraper|clamp|puller|extractor|plum blossom|slog|knife|blade|screw ?jack|grease gun|nail|awl|scissor|tweezer|magnet|brush|insert head|open insert|ring insert|extension bar|ring ?end|ring type|open type|t[- ]?handle|universal joint|circlip|sledge|speed handle|wedge flange|adapt[oe]r|\bhandle)/i],
];

export function deriveCategory(description = '', brand = '') {
  const text = `${description} ${brand}`;
  for (const [category, re] of CATEGORY_RULES) if (re.test(text)) return category;
  return 'General Hardware';
}

/**
 * Turn a mapped spreadsheet row into a catalogue item.
 * Returns null for rows with neither a part number nor a description.
 */
export function toCatalogueItem(row, mapping) {
  const pick = (field) => (mapping[field] ? row[mapping[field]] : undefined);

  const partNo = str(pick('partNo'));
  const description = str(pick('description'));
  if (!partNo && !description) return null;

  const brand = str(pick('brand')).toUpperCase();
  const price = parsePrice(pick('price'));

  return {
    code: partNo || `${brand}-${description}`.slice(0, 80),
    name: description,
    brand,
    category: deriveCategory(description, brand),
    units: str(pick('uom')) || 'Nos',
    listRate: price,
    gstRate: parseGst(pick('gst')) ?? 18,
    hsn: parseHsn(pick('hsn')),
    // Flags surfaced after import rather than silently accepted.
    missingHsn: !parseHsn(pick('hsn')),
    zeroPrice: price === 0,
    // Placeholder text that made it into the source list.
    needsReview: /category not found|^n\/?a$|^-+$|^test/i.test(description),
  };
}
