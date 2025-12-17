/**
 * Triage Classification Prompt
 *
 * Add this to the Retell AI system prompt (in Retell Dashboard).
 * The AI should internally classify each call before calling end_call().
 */
export const TRIAGE_CLASSIFICATION_PROMPT = `
## Call Classification (Internal - Before Ending Call)

Before calling end_call(), classify this interaction:

### Caller Type
- **residential**: Homeowner or tenant with HVAC issue
- **commercial**: Business owner/manager (restaurant, office, retail)
- **vendor**: Sales call, supplier, or service provider pitching services
- **recruiting**: Job seeker or staffing agency
- **unknown**: Cannot determine

### Primary Intent
- **new_lead**: New service request or estimate inquiry
- **active_job_issue**: Calling about existing appointment or recent service
- **booking_request**: Wants to schedule/reschedule/cancel appointment
- **admin_billing**: Payment, invoice, or account question
- **solicitation**: Trying to sell something to the business

### Callback Complaint
- **true**: Caller mentions previous service issue, technician didn't show, problem not fixed
- **false**: No complaint about prior service

Pass these classifications to end_call():
- caller_type: string
- primary_intent: string
- is_callback_complaint: boolean
`;

/**
 * Traffic Controller Classification Notes
 *
 * The following caller_type + primary_intent combinations route to spam/archive:
 * - caller_type: "vendor" (any intent)
 * - caller_type: "recruiting" (any intent)
 * - primary_intent: "solicitation" (any caller type)
 */
export const TRAFFIC_CONTROLLER_RULES = `
Calls from vendors, recruiters, or solicitors are automatically archived.
These still create records for review but don't trigger operator notifications.
`;
