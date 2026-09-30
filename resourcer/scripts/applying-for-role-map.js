#!/usr/bin/env node
/**
 * applying-for-role-map.js
 *
 * Maps a job title string to a Zoho Recruit `Applying_for_role` picklist value.
 *
 * Valid picklist values (as of 2026-03-14):
 *   Admin | Bar | Chef | Housekeeping | Kitchen Assistant |
 *   Kitchen Porter | Manager | Supervisor | Waiting
 *
 * Usage (as a module):
 *   const { mapToApplyingForRole } = require('./applying-for-role-map');
 *   mapToApplyingForRole('Sous Chef')       // => 'Chef'
 *   mapToApplyingForRole('Kitchen Porter')  // => 'Kitchen Porter'
 *   mapToApplyingForRole('Bar Manager')     // => 'Bar'
 *
 * Usage (CLI - for testing):
 *   node applying-for-role-map.js "Sous Chef"
 */

// Rules are checked in order - first match wins.
// Each rule: [regex, picklist_value]
const RULES = [
  // Kitchen Porter - check before generic "kitchen" / "porter" matches
  [/kitchen\s*porter/i,                   'Kitchen Porter'],
  [/kichen\s*porter/i,                    'Kitchen Porter'],  // common typo
  [/\bpot\s*wash/i,                       'Kitchen Porter'],
  [/\bpotwash/i,                          'Kitchen Porter'],
  [/\bdishwash/i,                         'Kitchen Porter'],
  [/kitchen\s*steward/i,                  'Kitchen Porter'],

  // Kitchen Assistant - before generic "kitchen" matches
  [/kitchen\s*assist/i,                   'Kitchen Assistant'],
  [/kichen\s*assist/i,                    'Kitchen Assistant'],
  [/catering\s*assist/i,                  'Kitchen Assistant'],
  [/canteen\s*assist/i,                   'Kitchen Assistant'],
  [/\bfood\s*(handler|preparer)/i,        'Kitchen Assistant'],
  [/food\s*prep(aration)?\s*assist/i,     'Kitchen Assistant'],
  [/food\s*production\s*(operative|partner|worker)/i, 'Kitchen Assistant'],
  [/school\s*(lunchtime|meal|catering)/i, 'Kitchen Assistant'],
  [/casual\s*catering/i,                  'Kitchen Assistant'],
  [/\bgeneral\s*catering/i,               'Kitchen Assistant'],

  // Bar roles - before Chef to catch barista etc.
  [/\bbar(man|maid|tender|ista|back|keep)?\b/i, 'Bar'],
  [/barista/i,                            'Bar'],
  [/bartend/i,                            'Bar'],
  [/cocktail/i,                           'Bar'],
  [/mixolog/i,                            'Bar'],
  [/\bbar\b/i,                            'Bar'],

  // Waiting / Front of House service
  [/\bwait(er|ress|staff|ing)?\b/i,       'Waiting'],
  [/\bserver\b/i,                         'Waiting'],
  [/front\s*of\s*house/i,                 'Waiting'],
  [/\bfoh\b/i,                            'Waiting'],
  [/\bhost(ess)?\b/i,                     'Waiting'],
  [/food\s*(and|&)\s*bever/i,             'Waiting'],
  [/\bf\s*&\s*b\b/i,                      'Waiting'],
  [/\bfood\s*runner/i,                    'Waiting'],
  [/food\s*service\s*(assist|work|staff)/i, 'Waiting'],
  [/restaurant\s*(assist|work|staff|floor)/i, 'Waiting'],
  [/\bfront\s*house/i,                    'Waiting'],
  [/\bcounter\s*assist/i,                 'Waiting'],
  [/caf\xe9?\s*(assist|attend)/i,         'Waiting'],

  // Housekeeping
  [/housekeep/i,                          'Housekeeping'],
  [/\blaundry\b/i,                        'Housekeeping'],
  [/room\s*attend/i,                      'Housekeeping'],

  // Supervisor
  [/\bsupervisor\b/i,                     'Supervisor'],
  [/\bteam\s*lead/i,                      'Supervisor'],

  // Admin
  [/\badmin/i,                            'Admin'],
  [/\boffice\b/i,                         'Admin'],
  [/\breception/i,                        'Admin'],

  // Chef - broad catch-all for anything kitchen/culinary
  [/souschef/i,                           'Chef'],
  [/working\s*chef\s*manager/i,          'Chef'],
  [/executive\s*chef/i,                   'Chef'],
  [/head\s*chef/i,                        'Chef'],
  [/chef\s*manager/i,                     'Chef'],
  [/kitchen\s*manager/i,                  'Chef'],
  [/\bchef\b/i,                           'Chef'],
  [/chef/i,                               'Chef'],
  [/\bcook\b/i,                           'Chef'],
  [/\bcdp\b/i,                            'Chef'],
  [/\bsous\b/i,                           'Chef'],
  [/\bcommis\b/i,                         'Chef'],
  [/\bpastr(y|ier)/i,                     'Chef'],
  [/patissi/i,                            'Chef'],
  [/\bbak(er|ery|ing)\b/i,               'Chef'],
  [/culinar/i,                            'Chef'],
  [/pizzaiolo/i,                          'Chef'],
  [/\bpizza\b/i,                          'Chef'],
  [/confection/i,                         'Chef'],
  [/cake\s*(decor|design)/i,              'Chef'],
  [/\bkitchen\b/i,                        'Chef'],
  [/\bkichen\b/i,                         'Chef'],
  [/\bcatering\b/i,                       'Chef'],  // catch-all for remaining catering titles

  // Manager - after all Chef rules
  [/\bmanager\b/i,                        'Manager'],
  [/\bmanageress\b/i,                     'Manager'],
  [/\bmanagement\b/i,                     'Manager'],
  [/\bgm\b/i,                             'Manager'],
  [/general\s*manager/i,                  'Manager'],
];

/**
 * Maps a job title to a Zoho Applying_for_role picklist value.
 * Returns null if no match - caller decides whether to skip or default.
 *
 * @param {string} jobTitle
 * @returns {string|null}
 */
function mapToApplyingForRole(jobTitle) {
  if (!jobTitle || typeof jobTitle !== 'string') return null;
  for (const [regex, value] of RULES) {
    if (regex.test(jobTitle)) return value;
  }
  return null;
}

// --- Phase 2: Skill_Set fallback --------------------------------------------
// Called when mapToApplyingForRole returns null.
// Scans the comma-separated Skill_Set string for hospitality signals.
// Returns a picklist value or null.

const SKILL_RULES = [
  // Bar - check before Chef/Kitchen
  ['Bar',              ['cellar management','cocktail','mixology','wine service','spirit','beverage service','wine knowledge','bartending','barista','craft beer']],
  // Housekeeping
  ['Housekeeping',     ['housekeeping','room cleaning','room attendant','linen','turndown']],
  // Waiting
  ['Waiting',          ['front of house','table service','silver service','waiting on tables','wine service','floor service','restaurant service','fine dining service']],
  // Kitchen Porter
  ['Kitchen Porter',   ['pot wash','potwash','dishwashing','kitchen cleaning','washing dishes']],
  // Kitchen Assistant
  ['Kitchen Assistant',['food preparation','food handling','kitchen hygiene','food hygiene','preparing food','food safety','food production','canteen']],
  // Chef - broadest kitchen/culinary signals
  ['Chef',             ['foodservice','food service','fine dining','back of house','indian cuisine','culinary','recipe development','menu development','haccp','hazard analysis and critical control','baking','pastry','cooking','knife skills','food allergen','garnishing','butchery','food costing','food tech']],
  // Manager
  ['Manager',          ['general management','operations management','restaurant management','catering management']],
];

/**
 * Maps a Zoho Skill_Set string to a picklist value.
 * Returns null if no signal found.
 *
 * @param {string} skillSet  comma-separated skill list
 * @returns {string|null}
 */
function mapFromSkillSet(skillSet) {
  if (!skillSet || typeof skillSet !== 'string') return null;
  const lower = skillSet.toLowerCase();
  for (const [value, keywords] of SKILL_RULES) {
    for (const kw of keywords) {
      if (lower.includes(kw)) return value;
    }
  }
  return null;
}

module.exports = { mapToApplyingForRole, mapFromSkillSet };

// CLI test mode
if (require.main === module) {
  const title = process.argv.slice(2).join(' ');
  if (title === '--help' || title === '-h') {
    console.log('Usage: node applying-for-role-map.js "Job Title"');
    process.exit(0);
  }
  if (!title) {
    console.log('Usage: node applying-for-role-map.js "Job Title"');
    process.exit(1);
  }
  const result = mapToApplyingForRole(title);
  console.log(`"${title}" => ${result || '(no match)'}`);
}
