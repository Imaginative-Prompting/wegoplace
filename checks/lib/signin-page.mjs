// Making an account on the sign-in page (public/login.html), as a person does: "Continue with a passkey" on a device
// with none for this site comes back without one and opens the account's making under it (#signin-make): a name, then
// Create account. A page from checks/lib/chrome.mjs has its own device (a virtual authenticator), empty until then.

/** Presses "Continue with a passkey" with no passkey here, and waits for the account's making to open. */
export async function openMaking(page) {
  await page.click("#btn-signin");
  await page.until(`!document.getElementById("signin-make").hidden`, "the account's making, after a sign-in with no passkey here", 30000);
}

/** Makes an account named `name` from the sign-in page; the caller waits for where it lands. */
export async function makeAccount(page, name) {
  await openMaking(page);
  await page.type("#join-name", name);
  await page.click("#btn-join");
}
