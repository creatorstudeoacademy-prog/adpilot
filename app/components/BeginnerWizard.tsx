import { useState } from "react";
import { useNavigate } from "@remix-run/react";
import {
  BlockStack,
  Button,
  Card,
  InlineStack,
  Text,
  TextField,
  Select,
  Banner,
} from "@shopify/polaris";

/**
 * 🧒 Beginner Wizard — "I don't understand ads" mode.
 * 3 simple questions → creates a campaign with safe defaults.
 * No jargon: no "objective", "placement", "optimization goal".
 */
export default function BeginnerWizard({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [product, setProduct] = useState("");
  const [budget, setBudget] = useState("5");
  const [country, setCountry] = useState("US");

  const start = () => {
    // Go to campaign create with beginner-friendly prefilled params.
    const params = new URLSearchParams({
      beginner: "1",
      product,
      budget,
      country,
    });
    navigate(`/app/ads/create?${params.toString()}`);
  };

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h2" variant="headingLg">
            🧒 Easy Start — no ad experience needed
          </Text>
          <Button variant="plain" onClick={onClose}>
            ✕ Close
          </Button>
        </InlineStack>

        <Banner tone="info">
          Answer 3 simple questions. AdPilot picks the best settings for you — you can change anything later.
        </Banner>

        {step === 1 && (
          <BlockStack gap="300">
            <Text as="p" variant="headingMd">
              Step 1 of 3: What do you want to sell?
            </Text>
            <TextField
              label="Product or offer"
              value={product}
              onChange={setProduct}
              placeholder="e.g. Blue quartz watch — 20% off this week"
              helpText="Describe it like you'd tell a friend."
              autoComplete="off"
            />
            <InlineStack align="end">
              <Button variant="primary" disabled={!product.trim()} onClick={() => setStep(2)}>
                Next →
              </Button>
            </InlineStack>
          </BlockStack>
        )}

        {step === 2 && (
          <BlockStack gap="300">
            <Text as="p" variant="headingMd">
              Step 2 of 3: How much per day?
            </Text>
            <TextField
              label="Daily budget (USD)"
              type="number"
              value={budget}
              onChange={setBudget}
              prefix="$"
              helpText="Start small. $5/day is perfect for testing. Budget Guardian watches it for you."
              autoComplete="off"
            />
            <InlineStack gap="200">
              {["5", "10", "20"].map((b) => (
                <Button key={b} pressed={budget === b} onClick={() => setBudget(b)}>
                  ${b}
                </Button>
              ))}
            </InlineStack>
            <InlineStack align="space-between">
              <Button onClick={() => setStep(1)}>← Back</Button>
              <Button variant="primary" onClick={() => setStep(3)}>
                Next →
              </Button>
            </InlineStack>
          </BlockStack>
        )}

        {step === 3 && (
          <BlockStack gap="300">
            <Text as="p" variant="headingMd">
              Step 3 of 3: Where are your customers?
            </Text>
            <Select
              label="Country"
              options={[
                { label: "United States", value: "US" },
                { label: "United Kingdom", value: "GB" },
                { label: "Canada", value: "CA" },
                { label: "Australia", value: "AU" },
                { label: "India", value: "IN" },
                { label: "Bangladesh", value: "BD" },
              ]}
              value={country}
              onChange={setCountry}
            />
            <Banner tone="success">
              ✅ Done! We'll target adults 18–65 in {country}, show your ad on Facebook & Instagram, and optimize for sales. Budget Guardian protects your ${budget}/day.
            </Banner>
            <InlineStack align="space-between">
              <Button onClick={() => setStep(2)}>← Back</Button>
              <Button variant="primary" onClick={start}>
                Create my campaign 🚀
              </Button>
            </InlineStack>
          </BlockStack>
        )}
      </BlockStack>
    </Card>
  );
}
