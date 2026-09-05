// Auth providers for this project (project decision, see ARCHITECTURE.md):
//   - Password: email + password sign-up/sign-in. Passwords are hashed with
//     Scrypt server-side. NO email verification and NO emails are ever sent:
//     accounts are recoverable on any device with email + password.
//   - Anonymous: one-tap guest login (device-local, no credentials).
// The email-OTP provider was removed because this project has no email
// handler and deliberately does not verify emails.

import { convexAuth } from "@convex-dev/auth/server";
import { Anonymous } from "@convex-dev/auth/providers/Anonymous";
import { Password } from "@convex-dev/auth/providers/Password";

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    Password({
      // Store the email (the credential id) plus the optional display name
      // the user typed at sign-up. Called on both flows; on sign-in `name`
      // is simply absent.
      profile: (params) => ({
        email: params.email as string,
        ...(params.name ? { name: params.name as string } : {}),
      }),
    }),
    Anonymous,
  ],
});