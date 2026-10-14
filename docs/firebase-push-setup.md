# RadarX native Firebase Cloud Messaging setup

The Build 224 backend already contains an FCM sender and the device registration API. The Android client now has the matching token registration and background notification receiver. Push remains disabled until both Firebase client configuration and the backend service-account credentials are configured.

## 1. Firebase Android app configuration

1. In Firebase Console, open the intended Firebase project and add an Android app with package name `com.radarx.ai`.
2. Download that app's `google-services.json` and place it at `app/google-services.json` in the RadarX repository before building the APK.
3. Confirm Firebase Cloud Messaging is available for the project. The receiving phone must have Google Play services.

The Gradle plugin is applied only when `app/google-services.json` exists. This keeps CI/builds working without a Firebase project file, but a build made without that file cannot obtain an FCM token and will not receive push alerts.

## 2. Server credentials — Railway only

In the existing Railway service `RadarX-AI-Triple`, set these variables together:

- `RADARX_PUSH_PROVIDER=fcm`
- `FCM_PROJECT_ID` = the Firebase project's exact project ID.
- `FCM_SERVICE_ACCOUNT_JSON` = the complete service-account JSON key, preferably pasted as compact one-line JSON.

Use a service account authorized to send Firebase Cloud Messaging messages, and ensure the Firebase Cloud Messaging API is enabled for that project. The project ID used by the server must match the project configured in `app/google-services.json`.

**Security:** never commit the service-account JSON, paste it into chat, or add it to the APK. Store it only as a protected Railway variable. The Android `google-services.json` contains app configuration/identifiers; it is not the server service-account key.

After all three Railway variables are set, apply and deploy them together. On the phone, install the APK built with the matching `google-services.json`, allow notifications, and open RadarX while online. The client registers its FCM token with `/api/push/device/register`; the backend does not return the token in responses. A successful deploy alone does not prove delivery, so check the service's push-provider status/log and confirm a test or radar alert arrives.

## 3. Safety boundaries

Push notifications are informational only. Payloads are accepted by the native service only when the backend marks `paper_trading=true` and `real_order_execution=false`. This change does not enable real orders, futures, leverage, or any Binance account/order API.
