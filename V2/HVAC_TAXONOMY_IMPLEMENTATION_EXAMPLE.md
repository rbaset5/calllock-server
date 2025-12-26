# V2 Backend Implementation Example

## Classification Service

```typescript
// src/services/tag-classifier.ts
import type { TaxonomyTags } from './types';

const HAZARD_PATTERNS = {
  GAS_LEAK: [
    'rotten egg smell',
    'hissing sound',
    'sulfur',
    'gas smell',
    'dead grass near unit',
  ],
  CO_EVENT: [
    'co alarm going off',
    'carbon monoxide detector',
    'dizzy',
    'headache and nausea',
    'family feels sleepy',
  ],
  ELECTRICAL_FIRE: [
    'burning smell from unit',
    'smoke from furnace',
    'sparks',
    'breaker keeps tripping',
    'smell like burning plastic',
  ],
  // ... more patterns
};

const URGENCY_PATTERNS = {
  CRITICAL_EVACUATE: [
    'evacuation',
    'need to leave',
    'call 911',
    'gas company',
  ],
  EMERGENCY_SAMEDAY: [
    'not working at all',
    'completely dead',
    'no air coming out',
    'froze up',
  ],
  // ... more patterns
};

export function classifyCall(
  transcript: string,
  metadata: {
    equipmentAge?: string;
    isCommercial?: boolean;
    hasVulnerableOccupants?: boolean;
  }
): TaxonomyTags {
  const tags: TaxonomyTags = {
    HAZARD: [],
    URGENCY: [],
    SERVICE_TYPE: [],
    REVENUE: [],
    RECOVERY: [],
    LOGISTICS: [],
    CUSTOMER: [],
    NON_CUSTOMER: [],
    CONTEXT: [],
  };

  const lowerTranscript = transcript.toLowerCase();

  // Classify HAZARD
  for (const [tag, patterns] of Object.entries(HAZARD_PATTERNS)) {
    if (patterns.some(p => lowerTranscript.includes(p))) {
      tags.HAZARD.push(tag);
    }
  }

  // Classify URGENCY
  for (const [tag, patterns] of Object.entries(URGENCY_PATTERNS)) {
    if (patterns.some(p => lowerTranscript.includes(p))) {
      tags.URGENCY.push(tag);
    }
  }

  // Upgrade urgency based on context
  if (metadata.hasVulnerableOccupants && tags.URGENCY.length > 0) {
    // Upgrade one level (implementation specific)
  }

  // Classify SERVICE_TYPE
  if (lowerTranscript.includes('ac') || lowerTranscript.includes('air conditioner')) {
    tags.SERVICE_TYPE.push('REPAIR_AC');
  } else if (lowerTranscript.includes('furnace') || lowerTranscript.includes('heat')) {
    tags.SERVICE_TYPE.push('REPAIR_HEATING');
  }

  // Classify LOGISTICS
  if (lowerTranscript.includes('gate code') || lowerTranscript.includes('keypad')) {
    tags.LOGISTICS.push('GATE_CODE');
  }
  if (lowerTranscript.includes('alarm')) {
    tags.LOGISTICS.push('ALARM_CODE');
  }

  // Classify REVENUE
  if (metadata.isCommercial) {
    tags.REVENUE.push('COMMERCIAL_LEAD');
  }
  if (lowerTranscript.includes('financing') || lowerTranscript.includes('payment plan')) {
    tags.REVENUE.push('FINANCING_REQ');
  }
  if (lowerTranscript.includes('freon') || lowerTranscript.includes('r-22')) {
    tags.REVENUE.push('R22_RETROFIT');
  }

  // Classify CUSTOMER
  if (metadata.isCommercial) {
    tags.CUSTOMER.push('COMMERCIAL_ACCT');
  } else {
    tags.CUSTOMER.push('OWNER_OCCUPIED');
  }

  // Classify CONTEXT
  const month = new Date().getMonth();
  if (month >= 5 && month <= 7) { // June-August
    tags.CONTEXT.push('PEAK_SUMMER');
  } else if (month >= 11 || month <= 1) { // Dec-Feb
    tags.CONTEXT.push('PEAK_WINTER');
  }

  if (metadata.hasVulnerableOccupants) {
    tags.CONTEXT.push('ELDERLY_OCCUPANT');
  }

  return tags;
}
```

## Webhook Integration

```typescript
// src/webhooks/dashboard-webhook.ts
import { classifyCall } from './services/tag-classifier';
import { sendToDashboard } from './services/dashboard-webhook';

export async function sendJobsWebhook(callData: CallData) {
  // Classify the call with taxonomy
  const tags = classifyCall(callData.transcript, {
    equipmentAge: callData.equipmentAge,
    isCommercial: callData.isCommercial,
    hasVulnerableOccupants: callData.hasVulnerableOccupants,
  });

  // Send to dashboard with taxonomy tags
  await sendToDashboard({
    call_id: callData.callId,
    customer_name: callData.customerName,
    customer_phone: callData.customerPhone,
    customer_address: callData.customerAddress,
    service_type: callData.serviceType,
    urgency: callData.urgency,
    end_call_reason: callData.endCallReason,
    ai_summary: callData.aiSummary,
    user_email: callData.userEmail,

    // Existing V5 fields
    sentiment_score: callData.sentimentScore,
    work_type: callData.workType,

    // V6: HVAC Smart Tag Taxonomy
    tags: tags,
  });
}
```

## Types Definition

```typescript
// src/types/taxonomy.ts

export type TaxonomyCategory =
  | 'HAZARD'
  | 'URGENCY'
  | 'SERVICE_TYPE'
  | 'REVENUE'
  | 'RECOVERY'
  | 'LOGISTICS'
  | 'CUSTOMER'
  | 'NON_CUSTOMER'
  | 'CONTEXT';

export type TaxonomyTags = {
  [K in TaxonomyCategory]?: string[];
};

// Example usage
const tags: TaxonomyTags = {
  HAZARD: ['GAS_LEAK'],
  URGENCY: ['CRITICAL_EVACUATE'],
  SERVICE_TYPE: ['REPAIR_HEATING'],
  // ... other categories
};
```

## Testing

```typescript
// __tests__/tag-classifier.test.ts
import { classifyCall } from '../src/services/tag-classifier';

describe('Tag Classifier', () => {
  test('detects gas leak', () => {
    const tags = classifyCall('I smell rotten eggs near my furnace', {});

    expect(tags.HAZARD).toContain('GAS_LEAK');
    expect(tags.URGENCY).toContain('CRITICAL_EVACUATE');
  });

  test('detects AC repair', () => {
    const tags = classifyCall('My AC is not cooling', {});

    expect(tags.SERVICE_TYPE).toContain('REPAIR_AC');
  });

  test('detects commercial lead', () => {
    const tags = classifyCall(
      'We need HVAC for our office building',
      { isCommercial: true }
    );

    expect(tags.REVENUE).toContain('COMMERCIAL_LEAD');
    expect(tags.CUSTOMER).toContain('COMMERCIAL_ACCT');
  });
});
```

## Priority Matrix

| Priority | Conditions | Dashboard Effect |
|----------|-------------|------------------|
| **HAZARD** | Any `HAZARD` tag present | Red pulsing card, top of queue |
| **RECOVERY** | `CALLBACK_RISK`, `COMPLAINT_*`, `ESCALATION_REQ`, `REVIEW_THREAT`, `LEGAL_MENTION` | Dark slate card, relationship focus |
| **REVENUE** | `HOT_LEAD`, `R22_RETROFIT`, `REPLACE_OPP`, `COMMERCIAL_LEAD`, `MULTI_PROPERTY` | Amber/gold card, sales focus |
| **LOGISTICS** | All other cases | Blue/gray card, standard flow |

Note: Dashboard determines archetype using tag presence, not field values. Backend should send ALL applicable tags.
