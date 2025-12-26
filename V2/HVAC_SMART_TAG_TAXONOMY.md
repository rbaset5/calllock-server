# V2 Backend: HVAC Smart Tag Taxonomy Implementation

## Overview

The dashboard (V4/V5) now supports the full 117-tag HVAC taxonomy from the document. V2 backend must classify calls using this taxonomy and send tags via webhook.

## Taxonomy Structure

```typescript
{
  HAZARD: string[],          // 7 tags: safety-critical
  URGENCY: string[],         // 8 tags: time-sensitivity
  SERVICE_TYPE: string[],    // 23 tags: repair/maintenance/install
  REVENUE: string[],        // 9 tags: sales opportunities
  RECOVERY: string[],       // 10 tags: retention/dispute
  LOGISTICS: string[],       // 20 tags: access/authorization
  CUSTOMER: string[],       // 15 tags: caller relationship
  NON_CUSTOMER: string[],    // 12 tags: vendor/spam
  CONTEXT: string[]          // 13 tags: seasonal/medical
}
```

## Webhook Payload Format

### Updated Jobs Webhook (/api/webhook/jobs)

Add `tags` field to the webhook payload:

```json
{
  "call_id": "call_xxx",
  "customer_name": "John Smith",
  "customer_phone": "+12345678900",
  "customer_address": "123 Main St",
  "service_type": "hvac",
  "urgency": "emergency",
  "end_call_reason": "callback_later",
  "ai_summary": "Customer reports gas smell...",
  "user_email": "user@example.com",

  // V5 Velocity fields (existing)
  "sentiment_score": 2,
  "work_type": "service",

  // V6 HVAC Smart Tag Taxonomy (NEW)
  "tags": {
    "HAZARD": ["GAS_LEAK", "OCCUPIED_HOME"],
    "URGENCY": ["CRITICAL_EVACUATE"],
    "SERVICE_TYPE": ["REPAIR_HEATING"],
    "REVENUE": [],
    "RECOVERY": [],
    "LOGISTICS": ["GATE_CODE", "ALARM_CODE"],
    "CUSTOMER": ["EXISTING_CUSTOMER", "OWNER_OCCUPIED"],
    "NON_CUSTOMER": [],
    "CONTEXT": ["PEAK_WINTER", "ELDERLY_OCCUPANT"]
  }
}
```

### Tag Values Reference

#### HAZARD (7 tags)
- `GAS_LEAK` - Rotten egg smell, hissing sound, sulfur
- `CO_EVENT` - CO alarm going off, dizzy, headache
- `ELECTRICAL_FIRE` - Burning smell, smoke, sparks
- `ACTIVE_FLOODING` - Water pouring, ceiling sagging, burst pipe
- `CONDENSATE_CLOG` - Dripping, drain pan full, small puddle
- `HEALTH_RISK` - No heat + freezing, no AC + vulnerable
- `REFRIGERANT_LEAK` - Chemical smell, sweet smell, hissing outdoor

#### URGENCY (8 tags)
- `CRITICAL_EVACUATE` - Any HAZARD requiring evacuation
- `CRITICAL_DISPATCH` - Complete failure + extreme temps + vulnerable
- `EMERGENCY_SAMEDAY` - Completely dead, froze up
- `URGENT_24HR` - Barely working, running constantly
- `PRIORITY_48HR` - Repeat customer, concerning symptoms
- `STANDARD` - Would like to schedule, routine
- `FLEXIBLE` - No rush, planning ahead
- `SEASONAL_RUSH` - Peak season, first extreme day

#### SERVICE_TYPE (23 tags)

**Repair Subcategory:**
- `REPAIR_AC` - AC not cooling, warm air
- `REPAIR_HEATING` - Furnace not working, no heat
- `REPAIR_HEATPUMP` - Heat pump issues, mode switching
- `REPAIR_THERMOSTAT` - Blank display, won't change temp
- `REPAIR_IAQ` - Humidifier, air purifier, UV light
- `REPAIR_DUCTWORK` - Duct disconnected, air not reaching room

**Maintenance Subcategory:**
- `TUNEUP_AC` - AC tune-up, summer maintenance
- `TUNEUP_HEATING` - Furnace tune-up, fall checkup
- `DUCT_CLEANING` - Air duct cleaning, dusty vents
- `FILTER_SERVICE` - Filter replacement, need new filter

**Installation Subcategory:**
- `INSTALL_REPLACEMENT` - Need new system, replacing unit
- `INSTALL_NEWCONSTRUCTION` - New build, building a house
- `INSTALL_UPGRADE` - Want more efficient, higher SEER
- `INSTALL_DUCTLESS` - Mini-split, ductless, room addition
- `INSTALL_THERMOSTAT` - Install smart thermostat, Nest, Ecobee

**Diagnostic Subcategory:**
- `DIAG_NOISE` - Strange noise, grinding, squealing
- `DIAG_SMELL` - Smells funny, musty, burning
- `DIAG_PERFORMANCE` - Not cooling/heating enough, uneven temps
- `DIAG_HIGHBILL` - Electric bill high, energy costs increased
- `DIAG_SECONDOPINION` - Another company said, want second opinion

#### REVENUE (9 tags)
- `R22_RETROFIT` - Freon, recharge, R-22 system
- `REPLACE_OPP` - Repair >50% of replacement, system >15yrs
- `FINANCING_REQ` - Payment plan, monthly payments, can't afford upfront
- `COMMERCIAL_LEAD` - Business address, rooftop, office
- `QUOTE_REQUEST` - Want estimate, how much to replace
- `QUOTE_FOLLOWUP` - Following up on estimate, thinking about proposal
- `COMPETITOR_QUOTE` - Got quote from competitor, shopping around
- `HOT_LEAD` - Multiple buying signals, ready to decide
- `MULTI_PROPERTY` - Rental properties, multiple homes, portfolio

#### RECOVERY (10 tags)
- `CALLBACK_RISK` - Tech was just here, still not working
- `REPEAT_ISSUE` - Third time calling, keeps happening
- `WARRANTY_DISPUTE` - Should be under warranty, why being charged
- `COMPLAINT_SERVICE` - Not happy with service, disappointed
- `COMPLAINT_TECH` - Tech was rude, didn't clean up
- `COMPLAINT_PRICE` - Way too expensive, overcharged
- `ESCALATION_REQ` - Want to speak to manager, supervisor
- `REVIEW_THREAT` - Going to leave review, BBB, Yelp
- `LEGAL_MENTION` - Lawyer, attorney, sue, legal action
- `MISSED_APPT` - Tech didn't show, no one came

#### LOGISTICS (20 tags)

**Access Requirements:**
- `GATE_CODE` - Gated community, gate code, keypad
- `GUARD_GATE` - Guard gate, need to be on list
- `LOCKBOX` - Won't be home, lockbox, key under mat
- `ALARM_CODE` - Have alarm, security system
- `EQUIP_ROOF` - Rooftop unit, package unit on roof
- `EQUIP_ATTIC` - In the attic, attic unit
- `EQUIP_CRAWLSPACE` - Crawlspace, under the house

**Authorization Requirements:**
- `LANDLORD_AUTH` - Tenant calling, rent, property manager
- `NTE_LIMIT` - Not to exceed, spending cap, budget limit
- `PO_REQUIRED` - Need a PO, purchase order
- `DECISION_MAKER` - Homeowner, my house, authorized

**Scheduling Preferences:**
- `TIME_AM` - Morning, first thing, early, before noon
- `TIME_PM` - Afternoon, after lunch, later in day, evening
- `TIME_SPECIFIC` - Has to be between X and Y
- `FIRST_CALL` - Need to be first, first appointment
- `CALLBACK_TIME` - Call me back at, I'll be available at

**Special Handling:**
- `PET_SECURE` - Have dogs, pets, need to put away
- `PREFERRED_TECH` - Want [name] again, same tech
- `SPANISH_PREF` - Habla español, Spanish spoken
- `HEARING_IMPAIRED` - Relay service, difficulty hearing
- `PARTS_PENDING` - Waiting on part, special order

#### CUSTOMER (15 tags)

**Relationship Status:**
- `NEW_CUSTOMER` - First time calling, never used you before
- `EXISTING_CUSTOMER` - Record found, return caller
- `REPEAT_CUSTOMER` - Multiple service calls, loyal customer
- `COMMERCIAL_ACCT` - Business account, commercial property

**Property Relationship:**
- `OWNER_OCCUPIED` - My house, homeowner living there
- `LANDLORD` - Rental property, I own but don't live there
- `TENANT` - I rent, landlord owns
- `PROPERTY_MANAGER` - Manage [X] properties, property management
- `REAL_ESTATE` - Selling house, buying, inspection

**Property Type:**
- `RES_SINGLE` - Standard house, single-family
- `RES_CONDO` - Condo, townhouse, HOA
- `RES_MULTI` - Apartment, duplex, multi-family
- `COMM_RESTAURANT` - Restaurant, kitchen, commercial kitchen
- `COMM_MEDICAL` - Doctor's office, dental, medical facility
- `COMM_SERVER` - Server room, data center, IT cooling

#### NON_CUSTOMER (12 tags)

**Employment:**
- `JOB_APPLICANT` - Applying for job, hiring, looking for work
- `EMPLOYMENT_VERIFY` - Verifying employment, background check
- `TRADE_SCHOOL` - HVAC program, apprenticeship, intern

**Partners & Referrals:**
- `HOME_WARRANTY` - Home warranty, calling for warranty company
- `REALTOR_REF` - Real estate agent, realtor referring
- `GC_REFERRAL` - General contractor, subcontract
- `TRADE_PARTNER` - Plumber/electrician calling, trade partner

**Vendors & B2B:**
- `VENDOR_SUPPLY` - Parts order, supply house, equipment delivery
- `B2B_SALES` - Marketing services, software demo, business opportunity
- `B2B_LEGIT` - Insurance renewal, fleet services, accounting

**Other:**
- `WRONG_NUMBER` - Different company
- `SPAM_TELEMARKETING` - Sales pitch, robo-call
- `MEDIA_INQUIRY` - Reporter, news, media inquiry

#### CONTEXT (13 tags)

**Seasonal Context:**
- `PEAK_SUMMER` - June through August
- `PEAK_WINTER` - December through February
- `SHOULDER` - Spring and fall
- `FIRST_EXTREME_DAY` - First day over 90°F or under 40°F
- `HOLIDAY` - Major holidays, holiday weekends

**Medical Context:**
- `ELDERLY_OCCUPANT` - Elderly, senior, grandmother/grandfather
- `INFANT_PRESENT` - Baby, infant, newborn
- `MEDICAL_CONDITION` - Medical condition, on oxygen, respiratory
- `MOBILITY_LIMITED` - Wheelchair, can't get around

**Situational Context:**
- `INSURANCE_CLAIM` - Filing claim, need documentation
- `POST_STORM` - Lightning strike, power surge, storm damage
- `POST_OUTAGE` - Power just came back, after outage
- `SYSTEM_AGE_15PLUS` - System over 15 years, pre-2010

## Implementation Priority

### Phase 1: Core Categories (MVP)
Implement these 4 categories first for immediate value:
1. **HAZARD** - Safety-critical (7 tags)
2. **URGENCY** - Dispatch priority (8 tags)
3. **SERVICE_TYPE** - What the call is about (23 tags)
4. **LOGISTICS** - Access/authorization (20 tags)

### Phase 2: Revenue & Recovery (High Value)
5. **REVENUE** - Sales opportunities (9 tags)
6. **RECOVERY** - Customer retention (10 tags)

### Phase 3: Advanced Classification
7. **CUSTOMER** - Caller relationship (15 tags)
8. **NON_CUSTOMER** - Filter out non-customers (12 tags)
9. **CONTEXT** - Situational modifiers (13 tags)

## Classification Logic

### Multi-Tag Architecture
Each call receives tags from **MULTIPLE categories** simultaneously.

```javascript
// Example: Gas leak call
const tags = {
  HAZARD: ['GAS_LEAK', 'OCCUPIED_HOME'],
  URGENCY: ['CRITICAL_EVACUATE'],
  SERVICE_TYPE: ['REPAIR_HEATING'],
  REVENUE: [],
  RECOVERY: [],
  LOGISTICS: [],
  CUSTOMER: ['EXISTING_CUSTOMER', 'OWNER_OCCUPIED'],
  NON_CUSTOMER: [],
  CONTEXT: ['ELDERLY_OCCUPANT', 'PEAK_WINTER']
};
```

### Detection Algorithm

```javascript
function classifyCall(transcript, callMetadata) {
  const tags = { HAZARD: [], URGENCY: [], ... };

  // HAZARD detection
  if (containsGasLeak(transcript)) {
    tags.HAZARD.push('GAS_LEAK');
  }
  if (containsCOAlarm(transcript)) {
    tags.HAZARD.push('CO_EVENT');
  }

  // URGENCY detection
  if (isEvacuationRequired(tags.HAZARD)) {
    tags.URGENCY.push('CRITICAL_EVACUATE');
  } else if (isSystemCompletelyDown(transcript)) {
    tags.URGENCY.push('EMERGENCY_SAMEDAY');
  }

  // SERVICE_TYPE detection
  if (isRepair(transcript)) {
    tags.SERVICE_TYPE.push('REPAIR_' + getEquipmentType(transcript));
  }

  // ... continue for all categories

  return tags;
}
```

## Testing

### Manual Webhook Test

```bash
curl -X POST https://calllock-dashboard-2.vercel.app/api/webhook/jobs \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: YOUR_WEBHOOK_SECRET" \
  -d '{
    "call_id": "call_test_123",
    "customer_name": "Test Customer",
    "customer_phone": "555-123-4567",
    "customer_address": "123 Test St, Dallas, TX",
    "service_type": "hvac",
    "urgency": "emergency",
    "end_call_reason": "callback_later",
    "ai_summary": "Customer reports gas smell from furnace - needs immediate evacuation",
    "user_email": "your-email@example.com",
    "sentiment_score": 2,
    "work_type": "service",
    "tags": {
      "HAZARD": ["GAS_LEAK", "OCCUPIED_HOME"],
      "URGENCY": ["CRITICAL_EVACUATE"],
      "SERVICE_TYPE": ["REPAIR_HEATING"],
      "REVENUE": [],
      "RECOVERY": [],
      "LOGISTICS": ["GATE_CODE"],
      "CUSTOMER": ["EXISTING_CUSTOMER", "OWNER_OCCUPIED"],
      "NON_CUSTOMER": [],
      "CONTEXT": ["PEAK_WINTER"]
    }
  }'
```

### Verification Checklist

- [ ] Webhook returns `{ success: true, lead_id: "..." }`
- [ ] Dashboard ACTION tab shows the lead
- [ ] Lead displays taxonomy-derived tags (not transcript-based)
- [ ] Velocity archetype matches HAZARD for gas leak
- [ ] Priority color and tags align with classification

## Dashboard Behavior

### Archetype Mapping

Dashboard maps taxonomy tags to velocity archetypes:

| Archetype | Tag Triggers | Dashboard Behavior |
|-----------|---------------|-------------------|
| **HAZARD** | Any `HAZARD` tag | Red pulsing, "Protect them" framing |
| **RECOVERY** | `CALLBACK_RISK`, `COMPLAINT_*`, `ESCALATION_REQ`, `REVIEW_THREAT`, `LEGAL_MENTION` | Dark/slate, "Save relationship" framing |
| **REVENUE** | `HOT_LEAD`, `R22_RETROFIT`, `REPLACE_OPP`, `COMMERCIAL_LEAD`, `MULTI_PROPERTY` | Amber/gold, "Secure the job" framing |
| **LOGISTICS** | Everything else | Blue/gray, "Keep machine running" framing |

### Display Tag Mapping

Dashboard shows 4 prioritized tags per card:

| Taxonomy Tag | Display Tag | Variant | Icon |
|--------------|---------------|-----------|-------|
| `GAS_LEAK` | Gas Leak | red | AlertTriangle |
| `CO_EVENT` | CO Risk | red | AlertTriangle |
| `CALLBACK_RISK` | Callback Risk | red | AlertCircle |
| `HOT_LEAD` | Hot Lead | red | Flame |
| `FINANCING_REQ` | Financing | green | CreditCard |
| `COMMERCIAL_LEAD` | Commercial $$$ | green | Building2 |
| `GATE_CODE` | Gate Code | blue | Key |
| `PET_SECURE` | Pet | amber | Dog |
| `REPAIR_AC` | AC Repair | blue | - |

### Fallback Behavior

If `tags` field is missing or empty, dashboard falls back to **transcript-based tag extraction** (existing behavior). This ensures backwards compatibility during backend rollout.

## Rollout Strategy

1. **Week 1**: Deploy V2 backend with Phase 1 tags (HAZARD, URGENCY, SERVICE_TYPE, LOGISTICS)
2. **Week 2**: Add Phase 2 tags (REVENUE, RECOVERY)
3. **Week 3**: Add Phase 3 tags (CUSTOMER, NON_CUSTOMER, CONTEXT)
4. **Ongoing**: Monitor tag accuracy, adjust detection logic

## Support

For questions about this implementation:
- Dashboard tag mapper: `src/lib/tag-taxonomy-mapper.ts`
- Webhook handler: `src/app/api/webhook/jobs/route.ts`
- Database schema: `supabase/migrations/0023_hvac_smart_tag_taxonomy.sql`
