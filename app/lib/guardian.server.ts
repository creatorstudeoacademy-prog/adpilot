import prisma from "../db.server";
import { decryptToken } from "./token-vault.server";
import { getCampaigns, getCampaignInsights, toggleCampaign } from "./meta-ads.server";
import { logActivity } from "./activity.server";

export interface GuardianResult {
  checked: number;
  paused: number;
  alerted: number;
  errors: number;
}

function countPurchases(actions?: Array<{ action_type: string; value: string }>): number {
  if (!actions) return 0;
  let total = 0;
  for (const a of actions) {
    const t = (a.action_type ?? "").toLowerCase();
    if (t === "purchase" || t === "offsite_conversion.fb_pixel_purchase" || t === "onsite_conversion.purchase") {
      total += parseInt(a.value ?? "0", 10) || 0;
    }
  }
  return total;
}

/**
 * Budget Guardian: runs on a schedule, checks every active Meta campaign
 * for shops with Guardian enabled, and pauses (or alerts on) campaigns
 * that are burning money.
 *
 * Rules (per shop settings):
 *  1. spend >= maxSpendNoPurchase AND purchases == 0 → pause/alert
 *  2. spend >= minSpendForRoas AND roas < minRoas → pause/alert
 *
 * ROAS here = purchases / spend (unit ROAS, since we count orders not revenue).
 * A campaign with 0 purchases after $20 is always killed — no exceptions.
 */
export async function runGuardianPass(): Promise<GuardianResult> {
  const result: GuardianResult = { checked: 0, paused: 0, alerted: 0, errors: 0 };

  const settings = await prisma.guardianSettings.findMany({ where: { enabled: true } });
  if (settings.length === 0) return result;

  for (const s of settings) {
    try {
      const [adAccounts, tokenRow] = await Promise.all([
        prisma.adAccount.findMany({ where: { shop: s.shop } }),
        prisma.metaUserToken.findUnique({ where: { shop: s.shop } }),
      ]);
      if (!tokenRow || adAccounts.length === 0) continue;
      const token = decryptToken(tokenRow.accessToken);

      for (const acct of adAccounts) {
        let campaigns: Awaited<ReturnType<typeof getCampaigns>>;
        try {
          campaigns = await getCampaigns(acct.adAccountId, token);
        } catch {
          continue;
        }
        const active = campaigns.filter((c) => c.status === "ACTIVE");

        for (const camp of active) {
          result.checked++;
          let insights;
          try {
            insights = await getCampaignInsights(camp.id, token);
          } catch {
            result.errors++;
            continue;
          }
          const purchases = countPurchases(insights.actions);
          const spend = insights.spend;
          const roas = spend > 0 ? purchases / spend : 0;

          // Skip if we already acted on this campaign in the last 24h.
          const recent = await prisma.guardianLog.findFirst({
            where: {
              shop: s.shop,
              campaignId: camp.id,
              createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
            },
          });
          if (recent) continue;

          // Autopilot: flag winners for scaling (ROAS 3x+ with meaningful spend).
          if (purchases >= 5 && roas >= 3 && spend >= 50) {
            const scaled = await prisma.guardianLog.findFirst({
              where: {
                shop: s.shop,
                campaignId: camp.id,
                action: "scale_suggested",
                createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
              },
            });
            if (!scaled) {
              await prisma.guardianLog.create({
                data: {
                  shop: s.shop,
                  campaignId: camp.id,
                  campaignName: camp.name,
                  action: "scale_suggested",
                  reason: `Winner! ROAS ${roas.toFixed(1)}x on ${spend.toFixed(2)} spend — consider increasing budget 20-30%.`,
                  spend,
                  purchases,
                  roas,
                },
              });
            }
            // Trigger a review prompt on first winner.
            const prompted = await prisma.reviewPrompt.findFirst({
              where: { shop: s.shop, trigger: "winner_scaled" },
            });
            if (!prompted) {
              await prisma.reviewPrompt.create({
                data: { shop: s.shop, trigger: "winner_scaled" },
              });
            }
            continue;
          }

          let reason: string | null = null;
          if (purchases === 0 && spend >= s.maxSpendNoPurchase) {
            reason = `Spent ${spend.toFixed(2)} with zero purchases (limit: ${s.maxSpendNoPurchase})`;
          } else if (spend >= s.minSpendForRoas && purchases > 0 && roas < s.minRoas) {
            reason = `ROAS ${roas.toFixed(2)} below minimum ${s.minRoas} after ${spend.toFixed(2)} spend`;
          }
          if (!reason) continue;

          if (s.notifyOnly) {
            await prisma.guardianLog.create({
              data: {
                shop: s.shop,
                campaignId: camp.id,
                campaignName: camp.name,
                action: "alerted",
                reason,
                spend,
                purchases,
                roas,
              },
            });
            result.alerted++;
          } else {
            try {
              await toggleCampaign(camp.id, token, false);
            } catch {
              result.errors++;
              continue;
            }
            await prisma.guardianLog.create({
              data: {
                shop: s.shop,
                campaignId: camp.id,
                campaignName: camp.name,
                action: "paused",
                reason,
                spend,
                purchases,
                roas,
              },
            });
            logActivity({
              shop: s.shop,
              action: "guardian_pause",
              detail: `Budget Guardian paused "${camp.name}": ${reason}`,
            });
            result.paused++;
          }
        }
      }
    } catch {
      result.errors++;
    }
  }
  return result;
}
