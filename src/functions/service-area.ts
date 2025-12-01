import {
  ValidateServiceAreaParams,
  ValidateServiceAreaResult,
} from "../types/retell.js";
import { createModuleLogger } from "../utils/logger.js";
import { fetchWithRetry, FetchError } from "../utils/fetch.js";

const log = createModuleLogger("service-area");

const N8N_WEBHOOK_BASE_URL = process.env.N8N_WEBHOOK_BASE_URL;
const SERVICE_AREA = process.env.SERVICE_AREA || "Austin and surrounding areas";

// Parse service area ZIP codes from environment
const SERVICE_AREA_ZIPS = new Set(
  (process.env.SERVICE_AREA_ZIPS || "78701,78702,78703,78704,78705")
    .split(",")
    .map((zip) => zip.trim())
);

/**
 * Validate if a ZIP code is within the service area
 */
export async function validateServiceArea(
  params: ValidateServiceAreaParams
): Promise<ValidateServiceAreaResult> {
  log.info({ zipCode: params.zipCode }, "Validating ZIP code");

  // If n8n webhook is configured, use it for more complex validation
  if (N8N_WEBHOOK_BASE_URL) {
    try {
      const response = await fetchWithRetry(
        `${N8N_WEBHOOK_BASE_URL}/service-area/validate`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Webhook-Secret": process.env.N8N_WEBHOOK_SECRET || "",
          },
          body: JSON.stringify(params),
        },
        { retries: 1, timeout: 5000 }
      );

      if (response.ok) {
        const result = (await response.json()) as ValidateServiceAreaResult;
        log.info(
          { zipCode: params.zipCode, inServiceArea: result.inServiceArea },
          "n8n validation result"
        );
        return result;
      }
    } catch (error) {
      if (error instanceof FetchError) {
        log.warn({ error: error.message }, "n8n webhook failed, using local validation");
      } else {
        log.warn({ error }, "n8n webhook error, using local validation");
      }
      // Fall through to local validation
    }
  }

  // Local validation using configured ZIP codes
  return validateLocally(params.zipCode);
}

/**
 * Validate ZIP code locally
 */
function validateLocally(zipCode: string): ValidateServiceAreaResult {
  // Clean the ZIP code (remove spaces, take first 5 digits)
  const cleanZip = zipCode.replace(/\s/g, "").substring(0, 5);

  if (SERVICE_AREA_ZIPS.has(cleanZip)) {
    log.info({ zipCode: cleanZip }, "ZIP code is in service area");
    return {
      inServiceArea: true,
      message: "We serve this area.",
    };
  }

  log.info({ zipCode: cleanZip }, "ZIP code is outside service area");
  return {
    inServiceArea: false,
    message: `Sorry, we don't currently service ZIP code ${cleanZip}. We serve ${SERVICE_AREA}.`,
  };
}

/**
 * Get list of all service area ZIP codes
 */
export function getServiceAreaZips(): string[] {
  return Array.from(SERVICE_AREA_ZIPS);
}

/**
 * Check if address contains a valid service area ZIP
 * Useful for parsing full addresses
 */
export function extractAndValidateZip(
  address: string
): ValidateServiceAreaResult | null {
  // Try to extract ZIP code from address using regex
  const zipMatch = address.match(/\b(\d{5})(?:-\d{4})?\b/);

  if (zipMatch) {
    return validateLocally(zipMatch[1]);
  }

  return null;
}
