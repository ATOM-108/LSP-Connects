import { test, expect } from '@playwright/test';

const screens = [
  'screen_1_loading_splash',
  'screen_2_introduction',
  'screen_3_role_selection',
  'screen_4_customer_login',
  'screen_5_customer_registration',
  'screen_6_service_details_rate_card',
  'screen_7_regular_booking_slot_selection',
  'screen_8_customer_quick_service_request',
  'screen_9_booking_review_confirmation',
  'screen_10_booking_status_tracking',
  'screen_11_custom_quotation_review_approval',
  'screen_12_service_completion_payment_digital_receipt',
  'screen_13_customer_review_rating',
  'screen_14_customer_my_bookings',
  'screen_15_customer_profile_addresses',
  'screen_16_customer_complaint_submission',
  'screen_17_provider_login',
  'screen_18_provider_registration',
  'screen_19_provider_verification_status',
  'screen_20_provider_jobs_dashboard',
  'screen_21_provider_availability_indicator',
  'screen_22_provider_job_execution_status_management',
  'screen_23_provider_custom_quotation_submission',
  'screen_24_provider_doorstep_payment_completion',
  'screen_25_provider_earnings_payment_history',
  'screen_26_provider_profile_skills',
  'screen_27_provider_customer_ratings_feedback',
  'screen_28_admin_login',
  'screen_29_admin_dashboard_overview',
  'screen_30_admin_user_management',
  'screen_31_admin_service_category_standard_rate_management',
  'screen_32_admin_booking_management',
  'screen_33_admin_provider_verification_document_audit',
  'screen_34_admin_customer_complaints_dispute_handling',
  'screen_35_admin_management_overview_settings'
];

for (const screen of screens) {
  test(`Screen loads: ${screen}`, async ({ page }) => {
    const response = await page.goto(`/screens/${screen}/index.html`);
    expect(response?.status()).toBe(200);
    await expect(page.locator('body')).not.toBeEmpty();
  });
}

test('Introduction Get Started navigates to Role Selection', async ({ page }) => {
  await page.goto('/screens/screen_2_introduction/index.html');
  await page.getByRole('button', { name: /get started/i }).click();
  await expect(page).toHaveURL(/screen_3_role_selection/);
});

test('Customer registration rejects mismatched passwords', async ({ page }) => {
  await page.goto('/screens/screen_5_customer_registration/index.html');

  await page.locator('#fullName').fill('Test Customer');
  await page.locator('#mobileNumber').fill('9876543210');
  await page.locator('#emailAddress').fill('test@example.com');
  await page.locator('#postalCode').fill('500081');
  await page.locator('#streetAddress').fill('12 Test Street, Hyderabad');
  await page.locator('#password').fill('Pass12345!');
  await page.locator('#confirmPassword').fill('Different123!');
  await page.locator('#termsCheckbox').check();

  page.once('dialog', dialog => dialog.accept());

  await page.locator('#customerRegForm').evaluate(form => form.requestSubmit());

  await expect(page.locator('#submitBtn')).toContainText('Complete Customer Registration');
});

test('Customer registration succeeds with matching passwords', async ({ page }) => {
  await page.goto('/screens/screen_5_customer_registration/index.html');

  await page.locator('#fullName').fill('Test Customer');
  await page.locator('#mobileNumber').fill('9876543210');
  await page.locator('#emailAddress').fill('test@example.com');
  await page.locator('#postalCode').fill('500081');
  await page.locator('#streetAddress').fill('12 Test Street, Hyderabad');
  await page.locator('#password').fill('Pass12345!');
  await page.locator('#confirmPassword').fill('Pass12345!');
  await page.locator('#termsCheckbox').check();

  await page.locator('#customerRegForm').evaluate(form => form.requestSubmit());

  await expect(page.locator('#submitBtn')).toContainText('Registration Completed', { timeout: 5000 });
});

test('Customer login requires credentials', async ({ page }) => {
  await page.goto('/screens/screen_4_customer_login/index.html');

  const form = page.locator('form');
  const isValid = await form.evaluate(element => element.checkValidity());

  expect(isValid).toBe(false);
});

test('Customer login password visibility toggle works', async ({ page }) => {
  await page.goto('/screens/screen_4_customer_login/index.html');

  const password = page.locator('#password-input');

  await expect(password).toHaveAttribute('type', 'password');

  await page.locator('#toggle-password').click();

  await expect(password).toHaveAttribute('type', 'text');

  await page.locator('#toggle-password').click();

  await expect(password).toHaveAttribute('type', 'password');
});

test('Customer login Create Account navigates to registration', async ({ page }) => {
  await page.goto('/screens/screen_4_customer_login/index.html');

  await page.getByText('Create Customer Account').click();

  await expect(page).toHaveURL(/screen_5_customer_registration/);
});

test('Provider login Register button navigates to registration', async ({ page }) => {
  await page.goto('/screens/screen_17_provider_login/index.html');

  await page.getByText('Register as an Independent Service Provider').click();

  await expect(page).toHaveURL(/screen_18_provider_registration/);
});

test('Admin login requires all mandatory credentials', async ({ page }) => {
  await page.goto('/screens/screen_28_admin_login/index.html');

  const form = page.locator('form');
  const isValid = await form.evaluate(element => element.checkValidity());

  expect(isValid).toBe(false);
});

test('Admin login password visibility toggle works', async ({ page }) => {
  await page.goto('/screens/screen_28_admin_login/index.html');

  const password = page.locator('#admin-key');

  await expect(password).toHaveAttribute('type', 'password');

  await page.locator('#pwd-toggle').click();
  await expect(password).toHaveAttribute('type', 'text');

  await page.locator('#pwd-toggle').click();
  await expect(password).toHaveAttribute('type', 'password');
});

test('Provider login password visibility toggle works', async ({ page }) => {
  await page.goto('/screens/screen_17_provider_login/index.html');

  const password = page.locator('#password-input');

  await expect(password).toHaveAttribute('type', 'password');

  await page.getByRole('button', { name: 'Toggle password visibility' }).click();
  await expect(password).toHaveAttribute('type', 'text');

  await page.getByRole('button', { name: 'Toggle password visibility' }).click();
  await expect(password).toHaveAttribute('type', 'password');
});

test('Provider login requires credentials', async ({ page }) => {
  await page.goto('/screens/screen_17_provider_login/index.html');

  const form = page.locator('form');
  const isValid = await form.evaluate(element => element.checkValidity());

  expect(isValid).toBe(false);
});

test('Provider registration screen displays correctly', async ({ page }) => {
  await page.goto('/screens/screen_18_provider_registration/index.html');

  await expect(page.getByPlaceholder('Enter full legal name')).toBeVisible();
  await expect(page.getByText('Submit Application for Admin Verification')).toBeVisible();
});
test('Customer registration requires mandatory fields', async ({ page }) => {
  await page.goto('/screens/screen_5_customer_registration/index.html');

  const form = page.locator('#customerRegForm');

  const isValid = await form.evaluate(element => element.checkValidity());

  expect(isValid).toBe(false);
});test('Provider registration form displays required sections', async ({ page }) => {
  await page.goto('/screens/screen_18_provider_registration/index.html');

  await expect(page.getByPlaceholder('Enter full legal name')).toBeVisible();
  await expect(page.getByText('Submit Application for Admin Verification')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Personal & Contact Credentials' })).toBeVisible();
});