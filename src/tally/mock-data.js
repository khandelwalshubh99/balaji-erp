/**
 * Deterministic, realistic dataset for Balaji Enterprises.
 *
 * This exists ONLY to feed the simulated TallyPrime (src/tally/mock-server.js).
 * Nothing in the application reads this file — the app only ever sees Tally XML
 * over HTTP. When the real Tally is connected, this file becomes dead weight and
 * can be deleted.
 */

// ---------------------------------------------------------------------------
// Seeded PRNG — same seed always produces the same company data.
// ---------------------------------------------------------------------------
function hashSeed(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Catalogue shape — tools & MRO, matching Balaji Enterprises' actual lines.
// ---------------------------------------------------------------------------
const CATALOGUE = [
  {
    group: 'Hand Tools',
    brands: ['Taparia', 'Stanley', 'Groz'],
    families: [
      ['Combination Plier', ['150mm', '165mm', '185mm', '210mm'], 180, 640],
      ['Long Nose Plier', ['150mm', '200mm'], 190, 520],
      ['Screwdriver Set', ['6 Pc', '8 Pc', '12 Pc'], 320, 1450],
      ['Adjustable Wrench', ['150mm', '200mm', '250mm', '300mm'], 340, 1290],
      ['Ring Spanner Set', ['6-22mm 8 Pc', '6-32mm 12 Pc'], 890, 3400],
      ['Double Ended Spanner', ['6x7', '8x9', '10x11', '12x13', '14x15', '16x17', '18x19', '20x22'], 95, 340],
      ['Ball Pein Hammer', ['200g', '340g', '450g', '680g'], 240, 780],
      ['Hacksaw Frame', ['Fixed 300mm', 'Adjustable 300mm'], 310, 690],
      ['Allen Key Set', ['1.5-10mm 9 Pc', '2-12mm 10 Pc'], 260, 940],
      ['Pipe Wrench', ['10 inch', '14 inch', '18 inch', '24 inch'], 420, 2100],
      ['Bench Vice', ['4 inch', '5 inch', '6 inch'], 2400, 6800],
      ['Cold Chisel', ['150mm', '200mm', '250mm'], 130, 380],
    ],
  },
  {
    group: 'Power Tools',
    brands: ['DeWalt', 'Stanley', 'Bosch'],
    families: [
      ['Angle Grinder', ['4 inch 850W', '5 inch 1200W', '7 inch 2200W'], 3200, 11800],
      ['Impact Drill', ['13mm 650W', '13mm 800W'], 3900, 7400],
      ['Rotary Hammer', ['SDS 24mm', 'SDS 26mm', 'SDS 32mm'], 8200, 24500],
      ['Cut-Off Saw', ['14 inch 2200W'], 9600, 14200],
      ['Cordless Drill', ['12V 2Ah', '18V 2Ah', '18V 5Ah'], 5400, 21000],
      ['Jig Saw', ['600W', '710W'], 4800, 8900],
      ['Blower', ['600W', '800W'], 2100, 4300],
      ['Heat Gun', ['2000W'], 2600, 3900],
      ['Marble Cutter', ['110mm 1200W'], 3400, 6200],
    ],
  },
  {
    group: 'Cutting Tools',
    brands: ['Deneers', 'Groz', 'Addison'],
    families: [
      ['HSS Twist Drill Bit', ['3mm', '4mm', '5mm', '6mm', '8mm', '10mm', '12mm', '14mm', '16mm', '20mm'], 28, 420],
      ['Tap & Die Set', ['M3-M12 32 Pc', 'M6-M24 40 Pc'], 1900, 7600],
      ['End Mill Cutter', ['6mm 4F', '8mm 4F', '10mm 4F', '12mm 4F', '16mm 4F'], 380, 1850],
      ['Machine Reamer', ['6mm', '8mm', '10mm', '12mm'], 520, 1600],
      ['Carbide Insert', ['CNMG 120408', 'DNMG 150604', 'TNMG 160408', 'WNMG 080408'], 190, 460],
      ['Hole Saw', ['22mm', '32mm', '44mm', '65mm', '89mm'], 240, 980],
      ['Countersink Bit', ['10mm', '16mm', '20mm'], 180, 640],
    ],
  },
  {
    group: 'Measuring Instruments',
    brands: ['Mitutoyo', 'Groz', 'Stanley'],
    families: [
      ['Vernier Caliper', ['150mm Analog', '150mm Digital', '200mm Digital', '300mm Digital'], 1200, 9800],
      ['Outside Micrometer', ['0-25mm', '25-50mm', '50-75mm'], 1800, 4900],
      ['Dial Gauge', ['0-10mm 0.01', '0-5mm 0.01'], 1400, 3800],
      ['Steel Rule', ['150mm', '300mm', '600mm', '1000mm'], 90, 620],
      ['Measuring Tape', ['3m', '5m', '8m', '10m'], 140, 780],
      ['Feeler Gauge', ['13 Blade', '20 Blade'], 220, 560],
      ['Spirit Level', ['300mm', '600mm', '1200mm'], 380, 1650],
      ['Bevel Protractor', ['0-320 deg'], 2200, 3400],
    ],
  },
  {
    group: 'Abrasives',
    brands: ['Norton', 'Deneers', 'Bosch'],
    families: [
      ['Cutting Wheel', ['4 inch x 1mm', '4 inch x 1.6mm', '7 inch x 3mm', '14 inch x 3mm'], 22, 210],
      ['Grinding Wheel', ['4 inch x 6mm', '7 inch x 6mm'], 48, 190],
      ['Flap Disc', ['4 inch P60', '4 inch P80', '4 inch P120'], 42, 96],
      ['Emery Paper', ['P80 Sheet', 'P120 Sheet', 'P220 Sheet', 'P400 Sheet'], 12, 34],
      ['Wire Brush Wheel', ['4 inch', '6 inch'], 160, 480],
    ],
  },
  {
    group: 'Fasteners',
    brands: ['Unbrako', 'TVS', 'Groz'],
    families: [
      ['Hex Bolt HT 8.8', ['M6x25', 'M8x30', 'M10x40', 'M12x50', 'M16x60'], 4, 42],
      ['Allen Cap Screw', ['M4x16', 'M5x20', 'M6x25', 'M8x30', 'M10x40'], 3, 34],
      ['Hex Nut', ['M6', 'M8', 'M10', 'M12', 'M16'], 2, 18],
      ['Spring Washer', ['M6', 'M8', 'M10', 'M12'], 1, 8],
      ['Anchor Fastener', ['M8x75', 'M10x100', 'M12x120'], 18, 74],
    ],
  },
  {
    group: 'Safety Equipment',
    brands: ['Karam', '3M', 'Udyogi'],
    families: [
      ['Safety Helmet', ['Ratchet White', 'Ratchet Yellow', 'Ratchet Blue'], 240, 620],
      ['Safety Shoes', ['UK 6', 'UK 7', 'UK 8', 'UK 9', 'UK 10'], 1150, 3200],
      ['Hand Gloves', ['Cotton Knitted', 'Nitrile Coated', 'Leather Welding', 'Cut Resistant L5'], 38, 420],
      ['Face Shield', ['Polycarbonate 8 inch'], 340, 620],
      ['Safety Goggles', ['Clear', 'Dark'], 120, 340],
      ['Ear Muff', ['SNR 27dB'], 380, 780],
      ['Dust Mask', ['N95 Cup', '2 Ply Pack'], 24, 180],
      ['Full Body Harness', ['Double Lanyard'], 2100, 4600],
    ],
  },
  {
    group: 'Lubricants & Chemicals',
    brands: ['WD-40', '3M', 'Loctite'],
    families: [
      ['Cutting Oil', ['1 Ltr', '5 Ltr', '20 Ltr'], 280, 4200],
      ['Rust Remover Spray', ['200ml', '420ml'], 220, 620],
      ['Multipurpose Grease', ['500g', '1kg', '5kg'], 180, 1400],
      ['Contact Cleaner', ['500ml'], 320, 480],
      ['Thread Locker', ['10ml', '50ml'], 340, 1450],
      ['Anti-Spatter Spray', ['400ml'], 290, 420],
    ],
  },
  {
    group: 'Material Handling',
    brands: ['Groz', 'Indef', 'Deneers'],
    families: [
      ['Chain Pulley Block', ['1 Ton 3m', '2 Ton 3m', '3 Ton 3m', '5 Ton 3m'], 8900, 32000],
      ['Wire Rope Sling', ['8mm 2m', '10mm 3m', '12mm 3m'], 620, 2400],
      ['D-Shackle', ['1 Ton', '2 Ton', '3.2 Ton', '5 Ton'], 140, 780],
      ['Hydraulic Bottle Jack', ['5 Ton', '10 Ton', '20 Ton'], 1200, 4800],
      ['Webbing Sling', ['1 Ton 2m', '2 Ton 3m', '3 Ton 3m'], 380, 1600],
      ['Platform Trolley', ['150kg', '300kg'], 4200, 8600],
    ],
  },
  {
    group: 'Welding',
    brands: ['Esab', 'Ador', 'Deneers'],
    families: [
      ['Welding Electrode', ['2.5mm 5kg', '3.15mm 5kg', '4mm 5kg'], 480, 1350],
      ['MIG Wire', ['0.8mm 12.5kg', '1.2mm 15kg'], 1400, 2900],
      ['Welding Holder', ['300A', '600A'], 320, 940],
      ['Earth Clamp', ['300A', '600A'], 180, 520],
      ['Welding Cable', ['25 sqmm /mtr', '35 sqmm /mtr'], 190, 320],
      ['Welding Glass', ['Shade 10', 'Shade 11'], 28, 62],
    ],
  },
];

const CUSTOMER_NAMES = [
  'Ashok Auto Works', 'Shree Ganesh Engineering Works', 'Pithampur Precision Components Pvt Ltd',
  'Maruti Fabrication', 'Sanghvi Industries', 'Bhavani Tools & Dies', 'Kalyan Motors Workshop',
  'Indore Steel Fabricators', 'Vishwakarma Engineering', 'Rajhans Auto Components Pvt Ltd',
  'Om Sai Enterprises', 'Nakoda Industrial Services', 'Prestige Castings Pvt Ltd',
  'Sagar Machine Tools', 'Deepak Engineering Stores', 'Trimurti Fabricators',
  'Malwa Agro Machinery', 'Jain Hydraulics', 'Shakti Pumps Service Division',
  'Aditya Sheet Metal Works', 'Gurukripa Engineering', 'Narmada Auto Industries',
  'Sunrise CNC Machining', 'Balaji Industrial Fabricators', 'Krishna Tool Room',
  'Patel Engineering Works', 'Mahalaxmi Enterprises', 'Vardhman Precision Pvt Ltd',
  'Chetak Automotive Pvt Ltd', 'Sagar Cements Maintenance Dept', 'Aarti Industries Indore Unit',
  'Kesharwani Traders', 'Sanjay Metal Works', 'Bhagwati Rolling Mills',
  'Eagle Engineering Corporation', 'Ratlam Textile Mills Maintenance', 'Sharda Motors Works',
  'Vindhya Fasteners Pvt Ltd', 'Ujjain Foundry Works', 'Ganpati Plastics Pvt Ltd',
  'Metro Auto Electricals', 'Sethi Machine Works', 'Anand Agro Equipments',
  'Nova Precision Tools', 'Shriram Pipe Industries', 'Dewas Auto Components',
  'Jyoti Fabrication Services', 'Vaibhav Engineering Solutions', 'Sanwariya Traders',
  'Shivam Structurals', 'Alliance Engineering Pvt Ltd', 'Purohit Brothers Machinery',
  'Kailash Industrial Corporation', 'Sunbeam Auto Parts', 'Neelkanth Engineering',
  'Rathore Welding Works', 'Prime Tool Centre', 'Vaishnavi Enterprises',
  'Mangal Murti Industries', 'Bansal Sheet Metals', 'Radhe Engineering Works',
  'Tirupati Auto Garage', 'Sagar Hydraulics & Pneumatics', 'Kumar Industrial Supplies',
  'Excel Engineering Company',
];

const SUPPLIER_NAMES = [
  'Taparia Tools Ltd', 'Stanley Black & Decker India', 'DeWalt India Distribution',
  'Groz Engineering Tools Pvt Ltd', 'Deneers Tools Pvt Ltd', 'Bosch Power Tools India',
  'Mitutoyo South Asia Pvt Ltd', 'Saint-Gobain Norton Abrasives', 'Karam Industries',
  '3M India Ltd', 'Esab India Ltd', 'Loctite Henkel India', 'Unbrako Fasteners',
  'Addison & Co Ltd', 'Indef Hoists', 'Udyogi Plastics Pvt Ltd', 'WD-40 India',
  'Ador Welding Ltd', 'TVS Fasteners', 'Central Tool Traders Mumbai',
];

const STATES = ['Madhya Pradesh', 'Maharashtra', 'Gujarat', 'Rajasthan', 'Uttar Pradesh'];

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------
const pad = (n, w = 2) => String(n).padStart(w, '0');
const ymd = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const round2 = (n) => Math.round(n * 100) / 100;

/** Financial year label Tally-style, e.g. 2026-27 -> "2627" for voucher numbers. */
function fyTag(date) {
  const y = date.getMonth() + 1 >= 4 ? date.getFullYear() : date.getFullYear() - 1;
  return `${String(y).slice(2)}${String(y + 1).slice(2)}`;
}

export function buildCompany(seedStr, now = new Date()) {
  const rand = mulberry32(hashSeed(seedStr));
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const between = (lo, hi) => lo + rand() * (hi - lo);
  const intBetween = (lo, hi) => Math.floor(between(lo, hi + 1));

  // --- Stock items --------------------------------------------------------
  const stockItems = [];
  let skuCounter = 1000;
  for (const cat of CATALOGUE) {
    for (const [family, variants, loPrice, hiPrice] of cat.families) {
      for (const brand of cat.brands) {
        for (const variant of variants) {
          skuCounter += 1;
          const cost = round2(between(loPrice, hiPrice));
          const margin = between(1.14, 1.38);
          // Hold roughly Rs 8k-70k of value per SKU, so a Rs 32,000 chain block
          // sits in ones and twos while Rs 4 washers sit in thousands.
          const targetValue = between(8000, 70000);
          const nominalQty = Math.min(2500, Math.max(1, Math.round(targetValue / cost)));
          // Reorder level is a standing policy on the item, so it is derived from
          // the normal holding — not from today's quantity, which may be zero.
          const reorder = Math.max(2, Math.round(nominalQty * between(0.15, 0.4)));
          const qty = rand() < 0.05 ? 0 : Math.round(nominalQty * between(0.3, 1.8));
          const units = family.includes('/mtr') ? 'Mtr' : pick(['Nos', 'Nos', 'Nos', 'Pkt', 'Set']);
          stockItems.push({
            guid: `sim-item-${skuCounter}`,
            name: `${brand.toUpperCase()} ${family} ${variant}`,
            alias: `BE-${skuCounter}`,
            partNumber: `${brand.slice(0, 3).toUpperCase()}-${skuCounter}`,
            parent: cat.group,
            category: cat.group,
            brand,
            baseUnits: family.startsWith('Welding Cable') ? 'Mtr' : units,
            closingQty: qty,
            costRate: cost,
            sellRate: round2(cost * margin),
            reorderLevel: reorder,
            gstRate: pick([18, 18, 18, 12]),
            hsn: pick(['82055900', '84671900', '82077000', '90173000', '68042290', '73181500', '65061010', '27101980', '73158900', '83112000']),
          });
        }
      }
    }
  }

  // --- Party ledgers ------------------------------------------------------
  const ledgers = [];
  const customers = CUSTOMER_NAMES.map((name, i) => {
    const creditDays = pick([15, 30, 30, 30, 30, 45, 60]);
    const l = {
      guid: `sim-led-c-${i + 1}`,
      name,
      parent: 'Sundry Debtors',
      isCustomer: true,
      creditPeriodDays: creditDays,
      // Most accounts have a limit set; a handful are deliberately open, and a
      // few are running over it, which is exactly what Phase 4 will enforce.
      creditLimit: pick([0, 200000, 300000, 400000, 500000, 600000, 800000, 1000000, 1500000]),
      gstin: `23${String.fromCharCode(65 + intBetween(0, 25))}${String.fromCharCode(65 + intBetween(0, 25))}${intBetween(1000, 9999)}${String.fromCharCode(65 + intBetween(0, 25))}1Z${intBetween(1, 9)}`,
      state: rand() < 0.78 ? 'Madhya Pradesh' : pick(STATES),
      contact: `9${intBetween(100000000, 999999999)}`,
      openingBalance: 0,
    };
    ledgers.push(l);
    return l;
  });

  SUPPLIER_NAMES.forEach((name, i) => {
    ledgers.push({
      guid: `sim-led-s-${i + 1}`,
      name,
      parent: 'Sundry Creditors',
      isCustomer: false,
      creditPeriodDays: pick([30, 45, 60]),
      creditLimit: 0,
      gstin: '',
      state: pick(STATES),
      contact: '',
      openingBalance: 0,
    });
  });

  for (const name of ['Cash', 'HDFC Bank CC A/c', 'Sales - Tools & Hardware', 'Purchase - Tools & Hardware',
    'Output CGST', 'Output SGST', 'Output IGST', 'Freight & Cartage', 'Round Off']) {
    ledgers.push({
      guid: `sim-led-x-${name.replace(/\W+/g, '-').toLowerCase()}`,
      name,
      parent: name.includes('Bank') ? 'Bank OD A/c'
        : name === 'Cash' ? 'Cash-in-Hand'
        : name.startsWith('Sales') ? 'Sales Accounts'
        : name.startsWith('Purchase') ? 'Purchase Accounts'
        : name.includes('GST') ? 'Duties & Taxes' : 'Indirect Expenses',
      isCustomer: false,
      creditPeriodDays: 0,
      creditLimit: 0,
      gstin: '',
      state: '',
      contact: '',
      openingBalance: 0,
    });
  }

  // --- Outstanding sales bills (receivables) ------------------------------
  // Spread across ageing buckets so the dashboard has something honest to show.
  const bills = [];
  let billSeq = 100;
  const billCountByAge = [
    [1, 28, 62],    // current-ish
    [29, 60, 41],
    [61, 90, 22],
    [91, 210, 14],
  ];
  for (const [minAge, maxAge, count] of billCountByAge) {
    for (let i = 0; i < count; i++) {
      const party = pick(customers);
      const age = intBetween(minAge, maxAge);
      const billDate = addDays(now, -age);
      billSeq += 1;
      const amount = round2(between(4200, 285000));
      const settled = rand() < 0.22 ? round2(amount * between(0.15, 0.6)) : 0;
      bills.push({
        billRef: `BE/${fyTag(billDate)}/${pad(billSeq, 4)}`,
        partyName: party.name,
        billDate,
        creditPeriodDays: party.creditPeriodDays,
        dueDate: addDays(billDate, party.creditPeriodDays),
        openingAmount: amount,
        closingAmount: round2(amount - settled),
      });
    }
  }

  // --- Vouchers over the last 120 days ------------------------------------
  // Sales Orders that may or may not have a matching Delivery Note yet — this
  // is what Phase 1's "pending vs dispatched" snapshot is derived from.
  const vouchers = [];
  let soSeq = 500;
  let dnSeq = 500;
  let invSeq = billSeq;

  for (let dayBack = 120; dayBack >= 0; dayBack--) {
    const day = addDays(now, -dayBack);
    const dow = day.getDay();
    if (dow === 0) continue; // closed Sundays
    const ordersToday = intBetween(dow === 6 ? 1 : 3, dow === 6 ? 5 : 12);

    for (let i = 0; i < ordersToday; i++) {
      const party = pick(customers);
      const lineCount = intBetween(1, 6);
      const lines = [];
      let value = 0;
      for (let l = 0; l < lineCount; l++) {
        const item = pick(stockItems);
        const qty = intBetween(1, item.sellRate > 5000 ? 4 : 40);
        const rate = round2(item.sellRate * between(0.94, 1.02));
        const amount = round2(qty * rate);
        value += amount;
        lines.push({ item: item.name, qty, units: item.baseUnits, rate, amount });
      }
      value = round2(value);
      soSeq += 1;
      const soNumber = `SO/${fyTag(day)}/${pad(soSeq, 4)}`;

      vouchers.push({
        guid: `sim-vch-so-${soSeq}`,
        type: 'Sales Order',
        number: soNumber,
        date: day,
        partyName: party.name,
        amount: value,
        reference: soNumber,
        narration: '',
        lines,
      });

      // Older orders are almost always dispatched; recent ones are still open.
      const dispatchOdds = dayBack > 14 ? 0.97 : dayBack > 5 ? 0.82 : dayBack > 2 ? 0.55 : 0.25;
      if (rand() < dispatchOdds) {
        let lag = Math.min(dayBack, intBetween(0, 4));
        let dnDate = addDays(day, lag);
        // Nothing leaves the godown on a Sunday.
        while (dnDate.getDay() === 0 && lag < dayBack) dnDate = addDays(day, ++lag);
        if (dnDate.getDay() === 0) continue;
        dnSeq += 1;
        vouchers.push({
          guid: `sim-vch-dn-${dnSeq}`,
          type: 'Delivery Note',
          number: `DC/${fyTag(dnDate)}/${pad(dnSeq, 4)}`,
          date: dnDate,
          partyName: party.name,
          amount: value,
          reference: soNumber,
          narration: `Against ${soNumber}`,
          lines,
        });

        if (rand() < 0.93) {
          invSeq += 1;
          const invDate = addDays(dnDate, intBetween(0, 2));
          vouchers.push({
            guid: `sim-vch-inv-${invSeq}`,
            type: 'Sales',
            number: `BE/${fyTag(invDate)}/${pad(invSeq, 4)}`,
            date: invDate,
            partyName: party.name,
            amount: value,
            reference: soNumber,
            narration: `Being goods sold vide ${soNumber}`,
            lines,
          });
        }
      }
    }

    // Receipts
    const receipts = intBetween(0, 6);
    for (let r = 0; r < receipts; r++) {
      const party = pick(customers);
      vouchers.push({
        guid: `sim-vch-rcpt-${ymd(day)}-${r}`,
        type: 'Receipt',
        number: `RCPT/${fyTag(day)}/${ymd(day)}${r}`,
        date: day,
        partyName: party.name,
        amount: round2(between(5000, 320000)),
        reference: '',
        narration: pick(['NEFT', 'RTGS', 'Cheque', 'UPI']),
        lines: [],
      });
    }
  }

  // Party closing balances = sum of their open bills (Tally-consistent).
  const owedByParty = new Map();
  for (const b of bills) {
    owedByParty.set(b.partyName, round2((owedByParty.get(b.partyName) || 0) + b.closingAmount));
  }
  for (const l of ledgers) {
    if (l.isCustomer) {
      // Tally convention: a debit (customer owes us) is exported as negative.
      l.closingBalance = -(owedByParty.get(l.name) || 0);
      l.openingBalance = round2(l.closingBalance * 0.8);
    } else if (l.parent === 'Sundry Creditors') {
      l.closingBalance = round2(between(0, 480000));
      l.openingBalance = round2(l.closingBalance * 0.9);
    } else {
      l.closingBalance = round2(between(-2500000, 2500000));
      l.openingBalance = round2(l.closingBalance * 0.85);
    }
  }

  return {
    companyName: 'Balaji Enterprises',
    generatedAt: now,
    booksFrom: new Date(now.getMonth() + 1 >= 4 ? now.getFullYear() : now.getFullYear() - 1, 3, 1),
    ledgers,
    stockItems,
    bills,
    vouchers,
  };
}

/**
 * Gentle, deterministic stock drift so consecutive syncs show real movement
 * (otherwise every sync is a no-op and you can't tell the pipeline is alive).
 */
export function driftStock(company, minutesElapsed) {
  const rand = mulberry32(hashSeed(`drift-${Math.floor(minutesElapsed / 5)}`));
  for (const item of company.stockItems) {
    if (rand() < 0.02) {
      const delta = Math.floor(rand() * 9) - 4;
      item.closingQty = Math.max(0, item.closingQty + delta);
    }
  }
}
