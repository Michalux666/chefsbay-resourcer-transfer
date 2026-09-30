// Vendored from cv-corpus/lib/cv-lexicon.js (source sha256 7a7b3eb64d15) by tools/vendor-corpus.js; only mechanical edits, see that tool.
'use strict';
// Shared vocabulary for the CV redactor and the role parser. Plain data + tiny helpers, no I/O.
// Everything here is public vocabulary (months, job-title words, section headings, qualification names); it
// contains nothing taken from any real CV.

const MONTHS = {
  jan: 1, january: 1, janv: 1, feb: 2, february: 2, febr: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const MONTH_RE_SRC = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

// season -> [first month, last month]; winter wraps the year end
const SEASONS = {
  spring: [3, 5], summer: [6, 8], autumn: [9, 11], fall: [9, 11], winter: [12, 2],
};
const SEASON_RE_SRC = '(?:spring|summer|autumn|fall|winter)';

const PRESENT_RE_SRC = '(?:present|current|currently|now|today|to\u005cs+date|todate|till\u005cs+date|till\u005cs+now|until\u005cs+now|ongoing|on-going|current\u005cs+position|still\u005cs+working|onwards?)';

// ---------------------------------------------------------------------------
// Section headings

const SECTION_PATTERNS = [
  ['references', /^(?:professional\s+|character\s+|work\s+)?(?:referees?|references?)(?:\s+(?:details|available|on\s+request|upon\s+request|available\s+on\s+request|available\s+upon\s+request|can\s+be\s+(?:provided|supplied)|on\s+file|contacts?))*$/],
  ['experience', /^(?:(?:my|professional|relevant|recent|previous|prior|related|career|employment|work|working|industry|catering|hospitality|kitchen|chef|full\s+time|paid|practical|other|additional|further|past|earlier)\s+)*(?:work\s*)?(?:experience|history|employment|career|background|positions?\s+held|jobs?|roles?)(?:\s+(?:history|summary|record|details|to\s+date|and\s+(?:achievements|employment|experience|education|skills|training|qualifications)))?$/],
  ['experience', /^(?:work|employment|career)\s*(?:experience|history)?\s*(?:&|and)\s*(?:responsibilities|achievements|duties)$/],
  ['experience', /^(?:experience|employment|work\s+experience)\s*(?:&|and)\s*(?:education|training|qualifications|skills)$/],
  ['experience', /^(?:volunteer(?:ing)?|voluntary)\s*(?:work|experience)?$/],
  ['education', /^(?:(?:my|professional|academic|educational|formal|further|higher|relevant|additional|catering|hospitality|food|health|safety)\s+)*(?:education|qualifications?|certificat(?:es|ions?)|courses|training|academic(?:s)?|studies|awards|licen[cs]es)(?:\s+(?:and|&)\s+(?:training|courses|qualifications?|certificat(?:es|ions?)|education|awards|licen[cs]es|skills))?(?:\s+(?:history|details|achieved|completed|held))?$/],
  ['education', /^(?:education|qualifications|training)\s*(?:&|and)?\s*(?:development|professional\s+development)$/],
  ['skills', /^(?:(?:key|core|main|personal|professional|technical|practical|relevant|transferable|additional|kitchen|culinary|chef|catering|hospitality|other|special(?:i[sz]ed)?|useful|my)\s+)*(?:skills?|strengths|competenc(?:ies|y)|abilities|expertise|attributes|capabilities|specialit(?:ies|y))(?:\s+(?:summary|profile|and\s+(?:abilities|attributes|strengths|experience|interests|qualities)|&\s+(?:abilities|attributes|strengths|qualities)))?$/],
  ['skills', /^(?:areas?\s+of\s+(?:expertise|strength)|professional\s+skills\s+and\s+abilities|what\s+i\s+can\s+do)$/],
  ['summary', /^(?:(?:my|personal|professional|career|executive|work|candidate)\s+)*(?:profile|summary|statement|objectives?|overview|introduction|about\s+me|about|bio|goals?|aims?)(?:\s+(?:statement|summary|profile|objective))?$/],
  ['summary', /^(?:career|professional|personal)\s+(?:summary|profile|statement|objective|overview)$/],
  ['personal', /^(?:(?:my|personal|contact|candidate|private|individual)\s+)+(?:details|information|data|info|particulars|contact|contacts)$/],
  ['personal', /^(?:contact|contacts|contact\s+me|personal|details|about\s+you)$/],
  ['interests', /^(?:(?:my|personal|other|outside|extra[\s-]?curricular|additional)\s+)*(?:interests?|hobbies(?:\s+(?:and|&)\s+interests?)?|hobbies|activities|pastimes|pursuits|languages?|language\s+skills|other\s+information|additional\s+information|further\s+information|miscellaneous|other|declaration|availability|social|volunteering|extras?|notes?|other\s+details|additional\s+details|driving|driving\s+licen[cs]e)$/],
];

// Labels that sit inside a role block ("Responsibilities:", "Key achievements") and must not end the experience section
const SUBHEADING_RE = /^(?:main\s+|key\s+|core\s+|primary\s+)?(?:responsibilit(?:y|ies)|duties|achievements?|accomplishments?|tasks|job\s+description|role\s+description|description|projects?|highlights|role|summary\s+of\s+duties)(?:\s+(?:and|&)\s+(?:responsibilities|duties|achievements|accomplishments))?\s*:?$/i;

function isSubheading(line) {
  const s = stripHeadingDecoration(String(line || ''));
  return s.length > 2 && s.length < 40 && SUBHEADING_RE.test(s);
}

function stripHeadingDecoration(line) {
  return String(line || '')
    .replace(/[\u2022\u25aa\u25cf\u25e6\u2023\u00b7*#>_=|~]+/g, ' ')
    .replace(/^[\s\-:.\u2014]+|[\s\-:.\u2014]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Returns the section key of a heading-looking line, or null. Only short lines are considered.
function classifyHeading(line) {
  if (line === undefined || line === null) return null;
  const raw = String(line);
  if (raw.length > 60) return null;
  const s = stripHeadingDecoration(raw).toLowerCase().replace(/\s*&\s*/g, ' & ');
  if (s.length < 3 || s.length > 46) return null;
  if (/\d/.test(s)) return null;
  for (const [key, re] of SECTION_PATTERNS) if (re.test(s)) return key;
  // a combined heading ("Education and Experience", "Qualifications & Work History") is an experience heading when one of
  // its parts is: the education lines inside are filtered out later by the parser
  const parts = s.split(/\s*(?:&|\band\b|\/|,)\s*/).filter(Boolean);
  if (parts.length >= 2 && parts.length <= 3) {
    const keys = parts.map((p) => { for (const [key, re] of SECTION_PATTERNS) if (re.test(p)) return key; return null; });
    if (keys.every(Boolean) && keys.includes('experience')) return 'experience';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Job title / employer vocabulary (used for classification only, never to create a title)

const TITLE_WORDS = new Set((
  'chef cook cooks commis sous demi cdp kp porter waiter waitress waiting server bartender barman barmaid barista bar host hostess ' +
  'manager management supervisor director owner proprietor partner assistant assistants operative operatives attendant worker workers ' +
  'team member crew runner steward stewardess cashier sales advisor adviser consultant coordinator co-ordinator administrator officer ' +
  'executive engineer technician carer nurse teacher trainer apprentice trainee intern sommelier butcher baker pastry patissier patisserie ' +
  'kitchen catering banquet banqueting events event prep dishwasher dishwashing pot wash potwash cleaner housekeeper housekeeping ' +
  'receptionist driver courier lead leader head senior junior general deputy assistant chief master relief temp temporary casual ' +
  'freelance volunteer labourer warehouse picker packer security concierge valet groundsman gardener mechanic electrician plumber ' +
  'painter decorator floor food beverage service front house line production hygiene launderette laundry linen retail shop store ' +
  'stock merchandiser stocktaker customer care support agent clerk secretary pa bookkeeper accountant analyst developer designer ' +
  'buyer procurement logistics dispatch delivery picker forklift maintenance caretaker lifeguard instructor coach tutor lecturer ' +
  'butler maitre d maitre grill larder pastry saucier entremetier poissonnier rotisseur garde manger tournant chargehand ' +
  'restaurateur caterer cafe cafeteria canteen tea kitchenhand hand hands multi-skilled multiskilled all-rounder allrounder ' +
  'cellarman cellar bottling brewer distiller bakery baking confectioner chocolatier ice cream deli counter'
).split(/\s+/).filter(Boolean));

// words that mark a role level / occupation strongly (higher weight in title scoring)
const STRONG_TITLE_WORDS = new Set((
  'chef cook commis sous cdp porter waiter waitress bartender barista manager supervisor director assistant operative attendant ' +
  'cashier advisor adviser consultant coordinator administrator officer executive engineer technician carer nurse teacher trainer ' +
  'apprentice trainee sommelier butcher baker patissier dishwasher cleaner housekeeper receptionist driver courier host hostess ' +
  'steward stewardess runner server owner proprietor kp worker crew clerk secretary caterer barman barmaid labourer ' +
  'accountant bookkeeper analyst developer designer buyer planner scheduler inspector auditor technologist specialist operator ' +
  'controller handler loader stacker checker sorter machinist fitter nanny childminder dietician nutritionist mechanic electrician ' +
  'plumber painter decorator gardener groundsman lifeguard instructor coach tutor lecturer guard picker packer merchandiser ' +
  'stocktaker concierge valet butler chauffeur cellarman brewer baker confectioner chocolatier caretaker ' +
  'kitchenhand chargehand saucier entremetier poissonnier rotisseur tournant pizzaiolo grillardin plongeur maker expeditor member staff'
).split(/\s+/).filter(Boolean));

const EMPLOYER_WORDS = new Set((
  'ltd limited plc llp inc corp company co group holdings restaurant restaurants hotel hotels bar bars pub pubs inn inns cafe cafes ' +
  'bistro brasserie grill lodge club clubs golf resort spa hospital hospitals school schools care home homes nursery college university ' +
  'council nhs trust foundation catering services service contract contracts hospitality leisure entertainment events venue venues ' +
  'kitchen kitchens bakery bakeries deli takeaway takeaways cafeteria canteen manor castle hall house estate arms tavern gastropub ' +
  'theatre theater cinema stadium arena airport airline airlines railway station cruise ship ferry sodexo compass aramark ' +
  'bidfood brakes wetherspoon wetherspoons mcdonalds mcdonald\'s kfc subway nandos pret costa starbucks greggs tesco asda sainsburys ' +
  'morrisons waitrose lidl aldi marks spencer premier travelodge hilton marriott hyatt radisson ihg accor whitbread ' +
  'pizza pizzeria trattoria ristorante osteria taverna kebab burger fish chips curry indian chinese thai italian french ' +
  'winery vineyard distillery brewery brewing farm farms shop store stores supermarket mart market'
).split(/\s+/).filter(Boolean));

// ---------------------------------------------------------------------------
// Qualifications and skills as plain keywords. Each entry: [keyword, regex]

const QUALIFICATION_PATTERNS = [
  ['food-hygiene-l1', /(?:food\s+(?:hygiene|safety)[^\n]{0,40}?level\s*(?:1|one)\b|level\s*(?:1|one)\b[^\n]{0,40}?food\s+(?:hygiene|safety))/i],
  ['food-hygiene-l2', /(?:food\s+(?:hygiene|safety)[^\n]{0,40}?level\s*(?:2|two)\b|level\s*(?:2|two)\b[^\n]{0,40}?food\s+(?:hygiene|safety)|basic\s+food\s+hygiene|foundation\s+food\s+hygiene)/i],
  ['food-hygiene-l3', /(?:food\s+(?:hygiene|safety)[^\n]{0,40}?level\s*(?:3|three)\b|level\s*(?:3|three)\b[^\n]{0,40}?food\s+(?:hygiene|safety)|intermediate\s+food\s+hygiene)/i],
  ['food-hygiene-l4', /(?:food\s+(?:hygiene|safety)[^\n]{0,40}?level\s*(?:4|four)\b|level\s*(?:4|four)\b[^\n]{0,40}?food\s+(?:hygiene|safety)|advanced\s+food\s+hygiene)/i],
  ['food-hygiene-l5', /(?:food\s+(?:hygiene|safety)[^\n]{0,40}?level\s*(?:5|five)\b|level\s*(?:5|five)\b[^\n]{0,40}?food\s+(?:hygiene|safety))/i],
  ['food-hygiene', /\bfood\s+(?:hygiene|safety)\b/i],
  ['haccp', /\bhaccp\b/i],
  ['allergen-training', /\ballergen(?:s)?\b[^\n]{0,30}?(?:training|awareness|certificate|course|management)|(?:training|awareness|certificate|course)[^\n]{0,20}?\ballergen/i],
  ['nvq-l1', /\b(?:s?nvq|vrq)\b[^\n]{0,30}?level\s*(?:1|one)\b|\blevel\s*(?:1|one)\s+(?:s?nvq|vrq)\b/i],
  ['nvq-l2', /\b(?:s?nvq|vrq)\b[^\n]{0,30}?level\s*(?:2|two)\b|\blevel\s*(?:2|two)\s+(?:s?nvq|vrq)\b/i],
  ['nvq-l3', /\b(?:s?nvq|vrq)\b[^\n]{0,30}?level\s*(?:3|three)\b|\blevel\s*(?:3|three)\s+(?:s?nvq|vrq)\b/i],
  ['nvq-l4', /\b(?:s?nvq|vrq)\b[^\n]{0,30}?level\s*(?:4|four)\b|\blevel\s*(?:4|four)\s+(?:s?nvq|vrq)\b/i],
  ['nvq', /\bs?nvq\b/i],
  ['city-and-guilds', /\bcity\s*(?:&|and)\s*guilds\b|\bc&g\b|\bcg\s*7\d{2}\b/i],
  ['btec', /\bbtec\b/i],
  ['professional-cookery', /\bprofessional\s+cookery\b|\bcookery\s+(?:diploma|certificate|course)\b|\bculinary\s+(?:arts\s+)?(?:diploma|degree|certificate|school|college)\b/i],
  ['apprenticeship', /\bapprentice(?:ship)?\b/i],
  ['degree', /\b(?:b\.?sc|b\.?a\.?|m\.?sc|m\.?a\.?|bachelor(?:s)?|master(?:s)?|honours\s+degree|hnd|hnc|foundation\s+degree)\b/i],
  ['gcse', /\bgcse(?:s)?\b/i],
  ['a-level', /\ba[\s-]?levels?\b/i],
  ['coshh', /\bcoshh\b/i],
  ['manual-handling', /\bmanual\s+handling\b/i],
  ['first-aid', /\bfirst\s+aid(?:er)?\b/i],
  ['fire-safety', /\bfire\s+(?:safety|marshal|warden|awareness)\b/i],
  ['health-and-safety', /\bhealth\s*(?:&|and)\s*safety\b|\biosh\b|\bnebosh\b/i],
  ['personal-licence', /\bpersonal\s+licen[cs]e\b|\baplh\b|\bbiipl\b/i],
  ['wset', /\bwset\b/i],
  ['dbs', /\bdbs\b|\bcriminal\s+record\s+(?:check|certificate)\b/i],
  ['driving-licence', /\bdriving\s+licen[cs]e\b|\bfull\s+uk\s+licen[cs]e\b/i],
  ['safeguarding', /\bsafeguarding\b/i],
  ['rehis', /\brehis\b/i],
  ['cieh', /\bcieh\b/i],
  ['level-3-award', /\blevel\s*3\s+(?:award|certificate|diploma)\b/i],
  ['level-2-award', /\blevel\s*2\s+(?:award|certificate|diploma)\b/i],
  ['right-to-work', /\bright\s+to\s+work\b|\bsettled\s+status\b|\bwork\s+permit\b|\bvisa\b/i],
];

const SKILL_PATTERNS = [
  ['butchery', /\bbutcher(?:y|ing)?\b/i], ['pastry', /\bpastry\b|\bpatiss(?:erie|ier)\b/i], ['baking', /\bbak(?:e|ing|ery)\b/i],
  ['grill', /\bgrill(?:ing)?\b/i], ['sauces', /\bsauc(?:e|es|ier)\b/i], ['fine-dining', /\bfine\s+dining\b|\bmichelin\b|\brosette\b/i],
  ['a-la-carte', /\ba[\s-]?la[\s-]?carte\b/i], ['banqueting', /\bbanquet(?:s|ing)?\b/i], ['buffet', /\bbuffets?\b/i],
  ['catering', /\bcatering\b/i], ['menu-planning', /\bmenu\s+(?:planning|development|design|creation|costing)\b|\bmenus?\b[^\n]{0,20}?\b(?:plan|design|creat)/i],
  ['costing-gp', /\b(?:gp|gross\s+profit|margins?|costings?|costing|food\s+cost)\b/i], ['stock-control', /\bstock\s+(?:control|take|taking|rotation|management)\b|\bordering\b|\binventory\b/i],
  ['rota', /\brota(?:s|ing)?\b|\bscheduling\b|\brostering\b/i], ['staff-training', /\b(?:train(?:ing)?\s+(?:staff|new|junior|team)|staff\s+training|mentor(?:ing)?)\b/i],
  ['team-leadership', /\b(?:team\s+lead(?:er|ership)?|managed\s+a\s+team|led\s+a\s+team|leading\s+a\s+team|supervis(?:ed|ing|ion)|line\s+manag)\b/i],
  ['food-safety', /\bfood\s+(?:safety|hygiene)\b|\bhaccp\b/i], ['allergens', /\ballergens?\b/i], ['cleaning', /\bclean(?:ing|liness)?\b|\bsanitis|\bsanitiz/i],
  ['dishwashing', /\bdish\s*wash(?:ing|er)?\b|\bpot\s*wash(?:ing)?\b/i], ['food-prep', /\b(?:food\s+)?prep(?:aration|ping)?\b/i],
  ['cash-handling', /\bcash\s+(?:handling|up)\b|\btills?\b|\bpos\b|\bepos\b/i], ['customer-service', /\bcustomer\s+(?:service|care)\b|\bguest\s+(?:service|relations)\b/i],
  ['bartending', /\bbartend(?:er|ing)\b|\bcocktails?\b|\bmixolog/i], ['barista', /\bbarista\b|\bcoffee\s+machine\b/i], ['wine', /\bwines?\b|\bsommelier\b/i],
  ['silver-service', /\bsilver\s+service\b/i], ['events', /\bevents?\b|\bweddings?\b|\bfunctions?\b/i],
  ['vegan-vegetarian', /\bveg(?:an|etarian)\b|\bplant[\s-]based\b/i], ['halal', /\bhalal\b|\bkosher\b/i],
  ['cuisine-indian', /\bindian\b|\btandoori\b|\bcurry\b|\bbalti\b/i], ['cuisine-italian', /\bitalian\b|\bpasta\b|\bpizza\b|\brisotto\b/i],
  ['cuisine-french', /\bfrench\b|\bclassical\s+(?:french\s+)?cuisine\b/i], ['cuisine-asian', /\bthai\b|\bchinese\b|\bjapanese\b|\bsushi\b|\bwok\b|\bpan[\s-]asian\b|\bkorean\b/i],
  ['cuisine-mediterranean', /\bmediterranean\b|\bgreek\b|\bspanish\b|\btapas\b|\blebanese\b|\bmiddle\s+eastern\b/i], ['cuisine-british', /\bbritish\b|\bgastro\s*pub\b|\bpub\s+food\b|\broast(?:s)?\b/i],
  ['production-kitchen', /\bproduction\s+kitchen\b|\bcentral\s+production\b|\bcook[\s-]?chill\b|\bfood\s+production\b|\bfactory\b/i],
  ['school-hospital-catering', /\bschool\s+(?:meals|kitchen|catering|dinners)\b|\bhospital\b|\bcare\s+home\b|\bnursing\s+home\b|\bcontract\s+catering\b/i],
  ['hotel', /\bhotel\b/i], ['pub-bar', /\bpub\b|\bbar\b/i], ['cruise-ship', /\bcruise\b|\bships?\b/i],
  ['kitchen-porter', /\bkitchen\s+porter\b|\bkp\b/i], ['front-of-house', /\bfront\s+of\s+house\b|\bfoh\b/i], ['back-of-house', /\bback\s+of\s+house\b|\bboh\b/i],
  ['time-management', /\btime\s+management\b|\bunder\s+pressure\b|\bfast[\s-]paced\b/i], ['english-fluent', /\bfluent\s+english\b|\benglish\s+(?:fluent|speaking)\b/i],
  ['multilingual', /\b(?:bilingual|multilingual|spanish|portuguese|polish|romanian|arabic|urdu|hindi|punjabi|french|italian|german|bulgarian|lithuanian)\s+(?:speaking|speaker|fluent|native)\b|\bfluent\s+in\b/i],
  ['microsoft-office', /\b(?:microsoft\s+)?(?:office|excel|word|outlook)\b/i], ['health-safety', /\bhealth\s*(?:&|and)\s*safety\b/i],
];

// Words that are also common surnames/first names: standalone replacement of a candidate name token is skipped for
// these unless the token is next to another name token (they would corrupt titles/employers otherwise).
const COMMON_NAME_WORDS = new Set((
  'cook baker chef butcher carter cooper mason miller taylor smith king young hall hill park green white black brown grey gray ' +
  'rose may mark will bill grant hunt hunter fisher porter waiter wood stone field fields bell bird lamb lamb ward page west east ' +
  'north south lane long short little wright walker wells price rich richard joy hope faith grace chase church clark clarke ' +
  'dean duke earl frost gold golden lord love manager major marsh martin miles moon moore noble owen pearl pepper potter reed reid ' +
  'rice ross sage sands shaw sharp small star steel steward stewart summer sweet swift tanner thomas victor wall warren wild wise ' +
  'wolf york kitchen hotel restaurant bar pub food home house school college head sous senior junior general lead team member ' +
  'assistant service store shop grove holly hazel ivy olive rowan sandy robin june april august dawn eve angel amber ruby jade ' +
  'lily daisy violet iris jasmine ginger basil rosemary'
).split(/\s+/).filter(Boolean));

module.exports = {
  MONTHS, MONTH_RE_SRC, SEASONS, SEASON_RE_SRC, PRESENT_RE_SRC,
  SECTION_PATTERNS, classifyHeading, stripHeadingDecoration, isSubheading,
  TITLE_WORDS, STRONG_TITLE_WORDS, EMPLOYER_WORDS,
  QUALIFICATION_PATTERNS, SKILL_PATTERNS, COMMON_NAME_WORDS,
};
