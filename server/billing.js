const express = require('express');
const Stripe = require('stripe');
const { requireAuth } = require('./auth');
const { updateUser, getUserByStripeCustomerId } = require('./db');

// Fall back to a placeholder so the server can still boot (e.g. for testing
// auth locally) before Stripe is configured. Real Stripe calls will fail
// with a clear error from Stripe until STRIPE_SECRET_KEY is set for real.
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder_configure_in_env');
const APP_URL = process.env.APP_URL || 'http://localhost:3000';

const PLAN_PRICE_IDS = {
  basic: process.env.STRIPE_PRICE_BASIC,
  pro: process.env.STRIPE_PRICE_PRO,
};
const PRICE_ID_TO_PLAN = Object.fromEntries(
  Object.entries(PLAN_PRICE_IDS)
    .filter(([, v]) => !!v)
    .map(([plan, priceId]) => [priceId, plan])
);

const router = express.Router();

router.post('/create-checkout-session', requireAuth, async (req, res) => {
  try {
    const { plan } = req.body || {};
    const priceId = PLAN_PRICE_IDS[plan];
    if (!priceId) {
      return res.status(400).json({ error: 'Unknown plan. Expected "basic" or "pro".' });
    }

    let customerId = req.user.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: req.user.email,
        metadata: { userId: req.user.id },
      });
      customerId = customer.id;
      updateUser(req.user.id, { stripeCustomerId: customerId });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: req.user.id,
      subscription_data: { metadata: { userId: req.user.id } },
      success_url: `${APP_URL}/app.html?checkout=success`,
      cancel_url: `${APP_URL}/pricing.html?checkout=cancel`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('create-checkout-session error:', err.message);
    res.status(500).json({ error: 'Could not start checkout. Check your Stripe configuration.' });
  }
});

router.post('/create-portal-session', requireAuth, async (req, res) => {
  try {
    if (!req.user.stripeCustomerId) {
      return res.status(400).json({ error: 'No billing account found yet — subscribe first.' });
    }
    const session = await stripe.billingPortal.sessions.create({
      customer: req.user.stripeCustomerId,
      return_url: `${APP_URL}/app.html`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('create-portal-session error:', err.message);
    res.status(500).json({ error: 'Could not open the billing portal.' });
  }
});

function applySubscriptionToUser(userId, sub) {
  const priceId = sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].price
    ? sub.items.data[0].price.id
    : null;
  const plan = priceId ? PRICE_ID_TO_PLAN[priceId] || null : null;
  updateUser(userId, {
    subscriptionId: sub.id,
    subscriptionStatus: sub.status, // active | trialing | past_due | canceled | ...
    plan,
  });
}

// Mounted with express.raw() in server/index.js — do NOT apply express.json() to this route.
async function webhookHandler(req, res) {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = session.client_reference_id || (session.metadata && session.metadata.userId);
        if (userId && session.subscription) {
          const sub = await stripe.subscriptions.retrieve(session.subscription);
          applySubscriptionToUser(userId, sub);
        }
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const fromMetadata = sub.metadata && sub.metadata.userId;
        const fromLookup = getUserByStripeCustomerId(sub.customer);
        const userId = fromMetadata || (fromLookup && fromLookup.id);
        if (userId) applySubscriptionToUser(userId, sub);
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const fromMetadata = sub.metadata && sub.metadata.userId;
        const fromLookup = getUserByStripeCustomerId(sub.customer);
        const userId = fromMetadata || (fromLookup && fromLookup.id);
        if (userId) {
          updateUser(userId, { subscriptionStatus: 'canceled', plan: null, subscriptionId: null });
        }
        break;
      }
      default:
        break; // ignore events we don't care about
    }
    res.json({ received: true });
  } catch (err) {
    console.error('Webhook handling error:', err.message);
    res.status(500).json({ error: 'Webhook handler failed.' });
  }
}

module.exports = { router, webhookHandler };
