// Nigeria payout bank codes for the Afrstar gateway (sent in the payout `ifsc` field).
// Source: Afrstar Nigeria Payment API v2, section "Nigeria payout bank codes"
// (https://ngn.afrstar.com/doc/v2api.htm), 142 entries, checked 3 Nov 2026.
// Shared by the browser (withdrawal + admin bank dropdowns) and the server
// functions (validating codes, mapping free-text bank names typed before the
// gateway existed). No secrets in here.

export const NG_BANKS = [
    { name: "Access Bank", code: '80000001' },
    { name: "Citibank Nigeria", code: '80000002' },
    { name: "Ecobank Nigeria", code: '80000004' },
    { name: "Enterprise Bank", code: '80000005' },
    { name: "Fidelity Bank", code: '80000006' },
    { name: "First Bank of Nigeria", code: '80000007' },
    { name: "First City Monument Bank", code: '80000008' },
    { name: "Guaranty Trust Bank", code: '80000009' },
    { name: "Heritage Bank", code: '80000010' },
    { name: "Jaiz Bank", code: '80000011' },
    { name: "Keystone Bank", code: '80000012' },
    { name: "MainStreet Bank", code: '80000013' },
    { name: "Parallex Bank", code: '80000014' },
    { name: "Providus Bank", code: '80000015' },
    { name: "Polaris Bank", code: '80000016' },
    { name: "Stanbic IBTC Bank", code: '80000017' },
    { name: "Standard Chartered Bank", code: '80000018' },
    { name: "Sterling Bank", code: '80000019' },
    { name: "Suntrust Bank", code: '80000020' },
    { name: "Union Bank of Nigeria", code: '80000021' },
    { name: "United Bank For Africa (UBA)", code: '80000022' },
    { name: "Unity Bank", code: '80000023' },
    { name: "Wema Bank", code: '80000024' },
    { name: "Zenith Bank", code: '80000025' },
    { name: "eTranzact PocketMoni", code: '80000026' },
    { name: "TAJ Bank", code: '80000027' },
    { name: "Kuda Bank", code: '80000028' },
    { name: "Moniepoint MFB", code: '80000029' },
    { name: "OPay", code: '80000030' },
    { name: "FINCA Nigeria", code: '80000032' },
    { name: "PalmPay", code: '80000033' },
    { name: "Rubies MFB", code: '80000034' },
    { name: "Titan Trust Bank", code: '80000035' },
    { name: "Coronation Merchant Bank", code: '80000036' },
    { name: "Rand Merchant Bank", code: '80000037' },
    { name: "PAGA", code: '80000038' },
    { name: "Jubilee Life Mortgage Bank", code: '80000039' },
    { name: "GLOBUS BANK", code: '80000040' },
    { name: "NIRSAL NATIONAL MICROFINANCE BANK", code: '80000041' },
    { name: "HOPE PSB", code: '80000042' },
    { name: "ACCION MICROFINANCE BANK", code: '80000043' },
    { name: "VFD microfinance bank", code: '80000044' },
    { name: "Lotus bank", code: '80000045' },
    { name: "FFS MICROFINANCE BANK", code: '80000046' },
    { name: "SMARTCASH", code: '80000047' },
    { name: "EYOWO", code: '80000048' },
    { name: "LAPO MICROFINANCE BANK", code: '80000049' },
    { name: "PremiumTrust Bank", code: '80000050' },
    { name: "TANADI MFB (CRUST)", code: '80000051' },
    { name: "Abbey Mortgage Bank", code: '80000052' },
    { name: "FairMoney", code: '80000053' },
    { name: "Good News Microfinance Bank", code: '80000054' },
    { name: "Dot Microfinance Bank", code: '80000055' },
    { name: "Ibom Fadama Microfinance Bank", code: '80000056' },
    { name: "AKU Microfinance Bank", code: '80000057' },
    { name: "PRISTINE DIVITIS MICROFINANCE BANK LTD", code: '80000059' },
    { name: "Moneymaster PSB", code: '80000061' },
    { name: "Uhuru Microfinance Bank", code: '80000062' },
    { name: "Pillar Microfinance Bank", code: '80000063' },
    { name: "Aspire Microfinance Bank", code: '80000064' },
    { name: "Haggai Mortgage Bank", code: '80000065' },
    { name: "Manny Microfinance Bank", code: '80000067' },
    { name: "FSDH", code: '80000068' },
    { name: "Titan-Paystack Microfinance Bank", code: '80000069' },
    { name: "Rigo Microfinance Bank", code: '80000070' },
    { name: "Peace Microfinance Bank", code: '80000072' },
    { name: "Infinity Trust Mortgage Bank", code: '80000073' },
    { name: "Kredi Money Microfinance Bank", code: '80000074' },
    { name: "CORESTEP MICROFINANCE BANK", code: '80000075' },
    { name: "MOMO PSB", code: '80000076' },
    { name: "CARBON", code: '80000077' },
    { name: "Zikora Microfinance Bank", code: '80000078' },
    { name: "CROSS RIVER MICROFINANCE BANK LTD", code: '80000079' },
    { name: "Chukwunenye MFB", code: '80000080' },
    { name: "SPECTRUM MICROFINANCE BANK", code: '80000081' },
    { name: "Rehoboth MFB", code: '80000082' },
    { name: "Infinity Microfinance Bank", code: '80000083' },
    { name: "AB MICROFINANCE BANK", code: '80000085' },
    { name: "BRIGHTWAY MICROFINANCE BANK", code: '80000086' },
    { name: "Iyamoye Microfinance Bank", code: '80000087' },
    { name: "Parkway Microfinance Bank", code: '80000089' },
    { name: "Baines Credit MFB", code: '80000090' },
    { name: "Yes Microfinance Bank", code: '80000091' },
    { name: "Nice Microfinance Bank LTD", code: '80000093' },
    { name: "Delta Trust Mortgage Bank", code: '80000094' },
    { name: "UNICAL MICROFINANCE BANK", code: '80000096' },
    { name: "9 PAYMENT SERVICE BANK", code: '80000097' },
    { name: "AG MORTGAGE BANK", code: '80000098' },
    { name: "Nomba", code: '80000099' },
    { name: "Branch International Financial Services", code: '80000100' },
    { name: "GoMoney", code: '80000101' },
    { name: "Baobab MFB", code: '80000103' },
    { name: "AKWA SAVINGS & LOANS", code: '80000104' },
    { name: "NowNow", code: '80000106' },
    { name: "Aniocha MFB", code: '80000107' },
    { name: "SUPPORT MICROFINANCE BANK", code: '80000109' },
    { name: "Firmus Microfiance Bank", code: '80000113' },
    { name: "Safe Haven Microfinance Bank", code: '80000115' },
    { name: "NPF MFB", code: '80000116' },
    { name: "NEPTUNE MICROFINANCE BANK", code: '80000117' },
    { name: "KAYVEE MFB", code: '80000119' },
    { name: "Regent MFB", code: '80000120' },
    { name: "Rigo Microfinance Bank Limited", code: '80000121' },
    { name: "Otech Microfinance Bank Ltd", code: '80000122' },
    { name: "PREEMINENT MFB", code: '80000124' },
    { name: "Mainland Microfinance Bank", code: '80000125' },
    { name: "FIDFUND MICROFINANCE BANK LIMITED", code: '80000127' },
    { name: "Aztec Microfinance Bank Limited", code: '80000128' },
    { name: "Taj_Pinspay", code: '80000129' },
    { name: "CAPSTONE MICROFINANCE BANK", code: '80000135' },
    { name: "ZENITH EAZY WALLET", code: '80000137' },
    { name: "AFEMAI MICROFINANCE BANK", code: '80000139' },
    { name: "PAYSTACK PAYMENTS LIMITED", code: '80000141' },
    { name: "FEDETH Microfinance Bank", code: '80000143' },
    { name: "Oche Microfinance Bank Ltd", code: '80000144' },
    { name: "UNN Staff Microfinance Bank Ltd", code: '80000145' },
    { name: "Consistent Trust Microfinance Bank", code: '80000146' },
    { name: "Uzondu MFBank", code: '80000147' },
    { name: "MONARCH MICROFINANCE BANK", code: '80000148' },
    { name: "Chibueze microfinance bank", code: '80000150' },
    { name: "Platinum Mortgage Bank Limited", code: '80000152' },
    { name: "Links Microfinance Bank", code: '80000154' },
    { name: "OSCOTECH MICROFINANCE BANK", code: '80000158' },
    { name: "ISUOFIA MICROFINANCE BANK", code: '80000159' },
    { name: "NWANNEGADI MICROFINANCE BANK", code: '80000161' },
    { name: "UNIUYO MICROFINANCE BANK", code: '80000162' },
    { name: "OTUO MICROFINANCE BANK", code: '80000163' },
    { name: "Balera Microfinance Bank Limited", code: '80000165' },
    { name: "Letshego MFB", code: '80000166' },
    { name: "OCTOPUS MICROFINANCE BANK", code: '80000169' },
    { name: "Citizen Trust Microfinance Bank Limited", code: '80000171' },
    { name: "Ampersand Microfinance Bank", code: '80000172' },
    { name: "ASO Savings and Loans", code: '80000173' },
    { name: "Covenant Microfinance Bank", code: '80000174' },
    { name: "Ekondo Microfinance Bank", code: '80000175' },
    { name: "Enrich Microfinance Bank", code: '80000176' },
    { name: "Hackman Microfinance Bank", code: '80000177' },
    { name: "Hasal Microfinance Bank", code: '80000178' },
    { name: "IBILE Microfinance Bank", code: '80000179' },
    { name: "Imperial Homes Mortgage Bank", code: '80000180' },
    { name: "Mint-Finex MICROFINANCE BANK", code: '80000181' },
    { name: "Sparkle Microfinance Bank", code: '80000183' }
];

const BY_CODE = new Map(NG_BANKS.map(b => [b.code, b]));

/** The bank for a code, or null. */
export function bankByCode(code) {
    return BY_CODE.get(String(code || '').trim()) || null;
}

export function isValidBankCode(code) {
    return BY_CODE.has(String(code || '').trim());
}

/** Banks sorted A-Z for a dropdown (popular banks first when `popularFirst`). */
export const POPULAR_CODES = ['80000030', '80000033', '80000029', '80000028', '80000009', '80000001', '80000007', '80000022', '80000025', '80000006', '80000008', '80000017'];
export function sortedBanks({ popularFirst = false } = {}) {
    const az = NG_BANKS.slice().sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
    if (!popularFirst) return az;
    const pop = POPULAR_CODES.map(c => BY_CODE.get(c)).filter(Boolean);
    return [...pop, ...az.filter(b => !POPULAR_CODES.includes(b.code))];
}

/** <option> markup for a <select>. */
export function bankOptionsHtml({ selected = '', placeholder = 'Select bank', popularFirst = true } = {}) {
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    const opts = sortedBanks({ popularFirst }).map(b =>
        `<option value="${b.code}"${b.code === selected ? ' selected' : ''}>${esc(b.name)}</option>`);
    if (popularFirst) opts.splice(POPULAR_CODES.length, 0, '<option disabled>──────────</option>');
    return `<option value="">${esc(placeholder)}</option>` + opts.join('');
}

// Common ways people type bank names -> code. Keys are normalised (see norm()).
const ALIASES = {
    'access': '80000001', 'accessbank': '80000001', 'diamond': '80000001', 'diamondbank': '80000001', 'accessdiamond': '80000001',
    'citi': '80000002', 'citibank': '80000002',
    'eco': '80000004', 'ecobank': '80000004',
    'fidelity': '80000006', 'fidelitybank': '80000006',
    'firstbank': '80000007', 'first': '80000007', 'fbn': '80000007', 'firstbankofnigeria': '80000007', 'firstbanknigeria': '80000007',
    'fcmb': '80000008', 'firstcitymonumentbank': '80000008', 'firstcitymonument': '80000008',
    'gtb': '80000009', 'gtbank': '80000009', 'gt': '80000009', 'guaranty': '80000009', 'guarantytrust': '80000009', 'guarantytrustbank': '80000009', 'gtco': '80000009',
    'heritage': '80000010', 'jaiz': '80000011', 'keystone': '80000012', 'providus': '80000015', 'polaris': '80000016', 'skye': '80000016', 'skyebank': '80000016',
    'stanbic': '80000017', 'stanbicibtc': '80000017', 'ibtc': '80000017',
    'standardchartered': '80000018', 'sterling': '80000019', 'sterlingbank': '80000019', 'suntrust': '80000020',
    'union': '80000021', 'unionbank': '80000021',
    'uba': '80000022', 'unitedbankforafrica': '80000022', 'unitedbank': '80000022',
    'unity': '80000023', 'unitybank': '80000023',
    'wema': '80000024', 'wemabank': '80000024', 'alat': '80000024', 'alatbywema': '80000024',
    'zenith': '80000025', 'zenithbank': '80000025',
    'taj': '80000027', 'tajbank': '80000027',
    'kuda': '80000028', 'kudabank': '80000028', 'kudamfb': '80000028', 'kudamicrofinancebank': '80000028',
    'moniepoint': '80000029', 'moniepointmfb': '80000029', 'moniepointmicrofinancebank': '80000029', 'monie': '80000029',
    'opay': '80000030', 'opaydigital': '80000030', 'opaydigitalservices': '80000030', 'paycom': '80000030',
    'palmpay': '80000033', 'palm': '80000033',
    'rubies': '80000034', 'titan': '80000035', 'titantrust': '80000035', 'coronation': '80000036', 'paga': '80000038',
    'globus': '80000040', 'hope': '80000042', 'hopepsb': '80000042', 'vfd': '80000044', 'vbank': '80000044', 'lotus': '80000045',
    'smartcash': '80000047', 'airtelsmartcash': '80000047', 'eyowo': '80000048', 'lapo': '80000049', 'premiumtrust': '80000050',
    'fairmoney': '80000053', 'fairmoneymfb': '80000053', 'momo': '80000076', 'momopsb': '80000076', 'mtnmomo': '80000076',
    'carbon': '80000077', '9psb': '80000097', '9paymentservicebank': '80000097', '9mobile': '80000097',
    'nomba': '80000099', 'branch': '80000100', 'gomoney': '80000101', 'safehaven': '80000115', 'safehavenmfb': '80000115',
    'paystack': '80000141', 'parallex': '80000014', 'mainstreet': '80000013', 'enterprise': '80000005', 'fsdh': '80000068',
};

function norm(s) {
    return String(s || '').toLowerCase()
        .replace(/&/g, 'and')
        .replace(/\b(plc|ltd|limited|nigeria|nig|ng)\b/g, '')
        .replace(/[^a-z0-9]/g, '');
}

/**
 * Best-effort mapping of a free-text bank name (as typed by a user before
 * bank codes existed) to an Afrstar bank code. Returns null when unsure, so
 * the admin picks the bank by hand instead of money going to a wrong bank.
 */
export function guessBankCode(name) {
    const n = norm(name);
    if (!n) return null;
    if (ALIASES[n]) return ALIASES[n];
    const stripped = n.replace(/(bank|mfb|microfinancebank|microfinance|psb|plc)$/g, '');
    if (ALIASES[stripped]) return ALIASES[stripped];
    // Exact match on the directory name (normalised, with or without "bank").
    for (const b of NG_BANKS) {
        const bn = norm(b.name);
        if (bn === n || bn === n + 'bank' || bn.replace(/bank$/, '') === stripped) return b.code;
    }
    return null;
}
