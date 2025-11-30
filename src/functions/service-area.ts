import {
  ValidateServiceAreaParams,
  ValidateServiceAreaResult,
} from "../types/retell.js";

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
  console.log("[ServiceArea] Validating ZIP:", params.zipCode);

  // If n8n webhook is configured, use it for more complex validation
  if (N8N_WEBHOOK_BASE_URL) {
    try {
      const response = await fetch(`${N8N_WEBHOOK_BASE_URL}/service-area/validate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Secret": process.env.N8N_WEBHOOK_SECRET || "",
        },
        body: JSON.stringify(params),
      });

      if (response.ok) {
        return (await response.json()) as ValidateServiceAreaResult;
      }
    } catch (error) {
      console.error("[ServiceArea] n8n webhook error:", error);
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
    return {
      inServiceArea: true,
      message: "We serve this area.",
    };
  }

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
export function extractAndValidateZip(address: string): ValidateServiceAreaResult | null {
  // Try to extract ZIP code from address using regex
  const zipMatch = address.match(/\b(\d{5})(?:-\d{4})?\b/);

  if (zipMatch) {
    return validateLocally(zipMatch[1]);
  }

  return null;
}
