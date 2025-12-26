# V6 HVAC Smart Tag Taxonomy - Deployment Summary

## ✅ Completed (Dec 26, 2025)

### 1. Database Migration Applied (Manual Step Required)
- **Migration File**: `calllock-dashboard/supabase/migrations/0023_hvac_smart_tag_taxonomy.sql`
- **Status**: SQL prepared, ready to apply
- **Action Required**: Run migration in Supabase Dashboard SQL Editor
  - Go to: https://supabase.com/dashboard/project/xboybmqtwsxmdokgzclk/sql/new
  - Copy SQL from migration file and execute
- **Changes**:
  - Adds `tags JSONB` column to `leads` and `jobs` tables
  - Creates GIN indexes for fast tag queries
  - Adds helper functions: `has_tag()`, `get_category_tags()`

### 2. Dashboard Deployed to Vercel ✅
- **Repository**: https://github.com/rbaset5/calllock-dashboard
- **Commit**: `0c8c66f` - "feat: Add V6 HVAC Smart Tag Taxonomy integration (117 tags across 9 categories)"
- **Deployment URL**: https://calllock-dashboard-2.vercel.app
- **Status**: Deployed and live

**Files Modified/Created:**
- ✅ `src/lib/tag-taxonomy-mapper.ts` - Maps 117 tags to archetypes
- ✅ `src/types/database.ts` - Added tags field to Job/Lead types
- ✅ `src/lib/schemas/webhook-schemas.ts` - Added tags to webhook validation
- ✅ `src/app/api/webhook/jobs/route.ts` - Stores tags from webhook
- ✅ `src/lib/velocity.ts` - Uses taxonomy for archetype determination
- ✅ `src/lib/smart-tags.ts` - Uses taxonomy tags with transcript fallback
- ✅ `HVAC_TAXONOMY_TESTING_GUIDE.md` - Comprehensive testing guide

### 3. V2 Backend Updated ✅
- **Repository**: https://github.com/rbaset5/calllock-server
- **Commit**: `63e30b7` - "feat: Add HVAC Smart Tag Taxonomy classification service (V6)"
- **Deployment**: Render (https://calllock-server.onrender.com)
- **Status**: Code pushed, will deploy on next Render build

**Files Created:**
- ✅ `src/services/tag-classifier.ts` - 117-tag classification engine
- ✅ `HVAC_SMART_TAG_TAXONOMY.md` - Full taxonomy reference
- ✅ `HVAC_TAXONOMY_IMPLEMENTATION_EXAMPLE.md` - Implementation guide

**Files Modified:**
- ✅ `src/services/dashboard.ts` - Calls classifier and sends tags to dashboard

### 4. Documentation Created ✅
- ✅ `V2/test-taxonomy-webhook.sh` - Test script with 5 scenarios
- ✅ `calllock-dashboard/HVAC_TAXONOMY_TESTING_GUIDE.md` - Testing guide
- ✅ Root `CLAUDE.md` updated with V6 section

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        CALL FLOW                                │
└─────────────────────────────────────────────────────────────────┘

1. Customer calls → Retell AI Agent
2. Call ends → Retell sends webhook to V2 Backend
3. V2 Backend:
   - Classifies call using 117-tag taxonomy
   - Sends tags + call data to Dashboard webhook
4. Dashboard:
   - Receives tags in webhook payload
   - Maps tags to archetype (HAZARD > RECOVERY > REVENUE > LOGISTICS)
   - Stores tags in JSONB column
   - Displays velocity cards with taxonomy tags
```

## Taxonomy Structure (117 Tags, 9 Categories)

| Category | Count | Examples | Dashboard Effect |
|----------|-------|----------|------------------|
| **HAZARD** | 7 | GAS_LEAK, CO_EVENT, ELECTRICAL_FIRE | Red card, top priority |
| **URGENCY** | 8 | CRITICAL_EVACUATE, EMERGENCY_SAMEDAY | Urgency sorting |
| **SERVICE_TYPE** | 23 | REPAIR_AC, TUNEUP_HEATING, INSTALL_REPLACEMENT | Service categorization |
| **REVENUE** | 9 | HOT_LEAD, COMMERCIAL_LEAD, R22_RETROFIT | Amber card, sales focus |
| **RECOVERY** | 10 | CALLBACK_RISK, COMPLAINT_SERVICE | Dark slate card, retention |
| **LOGISTICS** | 20 | GATE_CODE, LANDLORD_AUTH, PET_SECURE | Access coordination |
| **CUSTOMER** | 15 | EXISTING_CUSTOMER, DECISION_MAKER | Relationship context |
| **NON_CUSTOMER** | 12 | SPAM_TELEMARKETING, WRONG_NUMBER | Filter out non-leads |
| **CONTEXT** | 13 | PEAK_SUMMER, ELDERLY_OCCUPANT | Situational awareness |

## Archetype Mapping (Priority Order)

Dashboard determines archetype using strict precedence:

```
1. HAZARD   → Any tag in HAZARD category (GAS_LEAK, CO_EVENT, etc.)
2. RECOVERY → CALLBACK_RISK, COMPLAINT_*, ESCALATION_REQ, REVIEW_THREAT, LEGAL_MENTION
3. REVENUE  → HOT_LEAD, R22_RETROFIT, REPLACE_OPP, COMMERCIAL_LEAD, MULTI_PROPERTY
4. LOGISTICS → All other cases (default)
```

## Webhook Payload Format

```json
{
  "call_id": "call_xxx",
  "customer_name": "John Smith",
  "customer_phone": "+12345678900",
  "service_type": "hvac",
  "urgency": "emergency",
  "user_email": "user@example.com",
  
  // V6: HVAC Smart Tag Taxonomy (NEW)
  "tags": {
    "HAZARD": ["GAS_LEAK"],
    "URGENCY": ["CRITICAL_EVACUATE"],
    "SERVICE_TYPE": ["REPAIR_HEATING"],
    "REVENUE": [],
    "RECOVERY": [],
    "LOGISTICS": ["GATE_CODE"],
    "CUSTOMER": ["EXISTING_CUSTOMER", "OWNER_OCCUPIED"],
    "NON_CUSTOMER": [],
    "CONTEXT": ["PEAK_WINTER"]
  }
}
```

## Next Steps

### 1. Apply Database Migration
```bash
# Option A: Use Supabase CLI
cd calllock-dashboard
supabase db push
# Enter database password when prompted

# Option B: Supabase Dashboard SQL Editor
# 1. Go to: https://supabase.com/dashboard/project/xboybmqtwsxmdokgzclk/sql/new
# 2. Copy SQL from: calllock-dashboard/supabase/migrations/0023_hvac_smart_tag_taxonomy.sql
# 3. Execute
```

### 2. Deploy V2 Backend to Render
The code is pushed to GitHub. Render will auto-deploy on next build, or you can trigger manually:
- Go to: https://dashboard.render.com
- Find: calllock-server
- Click: "Manual Deploy" → "Deploy latest commit"

### 3. Test End-to-End

**Using Test Script:**
```bash
cd V2
export WEBHOOK_SECRET="your-webhook-secret"
export USER_EMAIL="valid-user@example.com"
./test-taxonomy-webhook.sh
```

**Manual Test (Single Call):**
```bash
curl -X POST https://calllock-dashboard-2.vercel.app/api/webhook/jobs \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: YOUR_SECRET" \
  -d '{
    "call_id": "test_001",
    "customer_name": "Test Customer",
    "customer_phone": "+15551234567",
    "customer_address": "123 Test St",
    "service_type": "hvac",
    "urgency": "emergency",
    "end_call_reason": "callback_later",
    "ai_summary": "Gas leak suspected",
    "user_email": "VALID_USER@example.com",
    "tags": {
      "HAZARD": ["GAS_LEAK"],
      "URGENCY": ["CRITICAL_EVACUATE"],
      "SERVICE_TYPE": ["REPAIR_HEATING"],
      "REVENUE": [], "RECOVERY": [], "LOGISTICS": [],
      "CUSTOMER": ["EXISTING_CUSTOMER"],
      "NON_CUSTOMER": [], "CONTEXT": []
    }
  }'
```

**Verify in Dashboard:**
1. Go to: https://calllock-dashboard-2.vercel.app
2. Login with valid user credentials
3. Check ACTION tab for new lead
4. Verify:
   - Lead appears at top (HAZARD priority)
   - Card shows "Gas Leak" tag with red styling
   - Archetype = "HAZARD"
   - Tags display correctly (up to 4 per card)

### 4. Monitor Real Calls

Once V2 backend deploys, real Retell calls will automatically:
1. Get classified with taxonomy tags
2. Send tags to dashboard webhook
3. Display in velocity cards with proper archetype

**Monitor:**
- V2 Backend logs: Check Render logs for "Call classified with taxonomy"
- Dashboard webhook: Check Vercel logs for tag storage
- Database: Query `leads`/`jobs` tables for `tags` column

## Configuration Checklist

### V2 Backend (Render)
- ✅ Code deployed
- ⚠️ Environment variables (verify in Render):
  - `DASHBOARD_WEBHOOK_URL=https://calllock-dashboard-2.vercel.app/api/webhook/jobs`
  - `DASHBOARD_WEBHOOK_SECRET=<shared-secret>`
  - `DASHBOARD_USER_EMAIL=<valid-user-email>`

### Dashboard (Vercel)
- ✅ Code deployed
- ⚠️ Environment variables (verify in Vercel):
  - `WEBHOOK_SECRET=<same-shared-secret>`
  - `SUPABASE_SERVICE_ROLE_KEY=<service-key>`

### Supabase
- ⚠️ Apply migration 0023 (see step 1 above)

## Fallback Behavior

If V2 backend does NOT send tags (old version, or tags omitted):
- Dashboard automatically falls back to transcript-based tag extraction
- Uses existing `buildSmartTags()` logic from `src/lib/smart-tags.ts`
- Ensures backward compatibility with V5 behavior

## Success Metrics

After deployment, verify:

1. **Database**: `tags` column exists and contains JSONB data
2. **V2 Logs**: "Call classified with taxonomy" appears with tag counts
3. **Dashboard Logs**: Tags stored successfully in webhook handler
4. **UI**: Velocity cards display taxonomy tags with correct archetypes
5. **Archetype Logic**: HAZARD cards appear first, then RECOVERY, REVENUE, LOGISTICS

## Rollback Plan

If issues occur:

1. **Dashboard**: Revert to commit `3b2249c` (before taxonomy)
2. **V2 Backend**: Revert to commit `d800848` (before classifier)
3. **Database**: Tags column is nullable, safe to leave in place

No data loss - all changes are additive.

## Documentation

- **Full Taxonomy**: `V2/HVAC_SMART_TAG_TAXONOMY.md`
- **Implementation Guide**: `V2/HVAC_TAXONOMY_IMPLEMENTATION_EXAMPLE.md`
- **Testing Guide**: `calllock-dashboard/HVAC_TAXONOMY_TESTING_GUIDE.md`
- **Dashboard Architecture**: `calllock-dashboard/docs/ARCHITECTURE.md`
- **V2 Backend Architecture**: `V2/CLAUDE.md`

## Questions?

For issues or questions:
1. Check logs in Render (V2) and Vercel (Dashboard)
2. Review test output from `test-taxonomy-webhook.sh`
3. Verify environment variables match between V2 and Dashboard
4. Check Supabase logs for database errors

---

**Deployment Date**: December 26, 2025
**Version**: V6 - HVAC Smart Tag Taxonomy
**Status**: ✅ Code deployed, ⚠️ Manual steps required (DB migration, Render deploy)
