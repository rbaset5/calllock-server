
import "dotenv/config";

import crypto from "crypto";

// Colors for console output
const colors = {
    reset: "\x1b[0m",
    green: "\x1b[32m",
    red: "\x1b[31m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    bold: "\x1b[1m",
};

const V3_PORT = process.env.PORT || 8080;
const V3_URL = `http://localhost:${V3_PORT}`;
const RETELL_API_KEY = process.env.RETELL_API_KEY;

// Sample Payloads
const STANDARD_CALL = {
    event: "call_ended",
    call: {
        call_id: `test_v3_lead_${Date.now()}`,
        call_status: "ended",
        start_timestamp: Date.now() - 120000,
        end_timestamp: Date.now(),
        direction: "inbound",
        from_number: "+15551234567",
        to_number: "+15557654321",
        disconnection_reason: "user_hangup",
        transcript: "Hi, I need to get my AC parsed. It's making a weird noise.",
        call_analysis: {
            call_summary: "Customer reported noisy AC unit. Requested service.",
            user_sentiment: "Neutral",
            call_successful: false,
            custom_analysis_data: {
                customer_name: "Test User V3",
                service_address: "123 V3 Lane, Austin, TX",
                problem_description: "AC making loud noise",
                caller_type: "residential",
                primary_intent: "active_job_issue",
                is_callback_complaint: true,
                urgency_level: "Urgent",
                problem_duration: "2 days",
                problem_pattern: "constant",
                customer_attempted_fixes: "none"
            }
        },
    },
};

const EMERGENCY_TOOL_CALL = {
    call: {
        call_id: `emergency_call_${Date.now()}`,
        from_number: "+15559998888",
        direction: "inbound",
    },
    args: {
        urgency_description: "No heat, 20 degrees outside, elderly in home",
        caller_phone: "+15559998888",
        address: "123 Frozen Lane, Chillville",
        problem_duration: "2 hours",
    },
};

function signPayload(payload: any): string {
    if (!RETELL_API_KEY) return "";
    const body = JSON.stringify(payload);
    return crypto
        .createHmac("sha256", RETELL_API_KEY)
        .update(body)
        .digest("hex");
}

async function checkHealth() {
    try {
        const res = await fetch(`${V3_URL}/health`);
        if (res.ok) {
            console.log(`${colors.green}✔ V3 Server is running at ${V3_URL}${colors.reset}`);
            return true;
        }
    } catch (e) {
        console.log(`${colors.red}✖ V3 Server is NOT reachable at ${V3_URL}${colors.reset}`);
        console.log(`${colors.yellow}  -> We are attempting to start it...${colors.reset}`);
        return false;
    }
}

async function simulateCallEnded() {
    console.log(`\n${colors.bold}Test 1: Standard Lead Creation (Call Ended Webhook)${colors.reset}`);
    console.log(`${colors.blue}Sending payload to ${V3_URL}/webhook/retell/call-ended...${colors.reset}`);

    const payload = STANDARD_CALL;
    const signature = signPayload(payload);

    try {
        const res = await fetch(`${V3_URL}/webhook/retell/call-ended`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Retell-Signature": signature
            },
            body: JSON.stringify(payload),
        });

        const data = await res.json();
        if (res.ok) {
            console.log(`${colors.green}✔ Webhook accepted.${colors.reset}`);
            console.log("Response:", JSON.stringify(data, null, 2));
            if (data.job_id) {
                console.log(`${colors.green}✔ Job ID returned: ${data.job_id}${colors.reset}`);
                console.log(`${colors.bold}ACTION:${colors.reset} Check Dashboard for new Lead/Job from +15551234567`);
            } else if (data.action === "archived_spam") {
                console.log(`${colors.yellow}⚠ Call archived as SPAM.${colors.reset}`);
            }
        } else {
            console.log(`${colors.red}✖ Webhook failed: ${res.status} ${res.statusText}${colors.reset}`);
            console.log("Error:", JSON.stringify(data, null, 2));
        }
    } catch (e) {
        console.log(`${colors.red}✖ Request failed:${colors.reset}`, e);
    }
}

async function simulateEmergencyAlert() {
    console.log(`\n${colors.bold}Test 2: Emergency SMS Alert (Tool Call)${colors.reset}`);
    console.log(`${colors.blue}Sending payload to ${V3_URL}/webhook/retell/send_emergency_alert...${colors.reset}`);

    const payload = EMERGENCY_TOOL_CALL;
    const signature = signPayload(payload);

    try {
        const res = await fetch(`${V3_URL}/webhook/retell/send_emergency_alert`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Retell-Signature": signature
            },
            body: JSON.stringify(payload),
        });

        if (res.status === 401) {
            console.log(`${colors.yellow}⚠ Authentication failed. Retell Signature mismatch.${colors.reset}`);
            return;
        }

        const data = await res.json();
        if (res.ok) {
            console.log(`${colors.green}✔ Emergency Alert accepted.${colors.reset}`);
            console.log("Response:", JSON.stringify(data, null, 2));
            if (data.alertId) {
                console.log(`${colors.green}✔ Alert ID: ${data.alertId}${colors.reset}`);
                console.log(`${colors.bold}ACTION:${colors.reset} Check Dashboard for SMS Context log.`);
            }
        } else {
            console.log(`${colors.red}✖ Webhook failed: ${res.status}${colors.reset}`);
            console.log("Error:", JSON.stringify(data, null, 2));
        }

    } catch (e) {
        console.log(`${colors.red}✖ Request failed:${colors.reset}`, e);
    }
}

async function main() {
    console.log(`${colors.bold}=== CallLock Data Flow Verification ===${colors.reset}`);

    if (!process.env.RETELL_API_KEY) {
        console.log(`${colors.yellow}⚠ Warning: RETELL_API_KEY not found in .env. Signature generation will fail for protected endpoints.${colors.reset}`);
    }

    const isHealthy = await checkHealth();
    if (!isHealthy) {
        console.log(`${colors.red}Please run 'npm run dev' in V3 directory.${colors.reset}`);
        return;
    }

    await simulateCallEnded();
    await simulateEmergencyAlert();
}

main();
