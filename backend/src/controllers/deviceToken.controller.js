import { DeviceToken, User } from '../models/index.js';
import { ApiError, asyncHandler, ok } from '../utils/http.js';

export const registerDeviceToken = asyncHandler(async (req, res) => {
  const { token, platform, deviceId, appVersion } = req.body;
  if (!token || !platform) throw new ApiError(400, 'token and platform are required');
  if (!['web', 'android', 'ios'].includes(platform)) throw new ApiError(400, 'Invalid platform');

  const deviceToken = await DeviceToken.findOneAndUpdate(
    { user: req.user.id, token },
    {
      $set: {
        platform,
        deviceId: deviceId || null,
        appVersion: appVersion || null,
        isActive: true,
        lastUsedAt: new Date(),
      },
    },
    { upsert: true, new: true }
  );

  ok(res, { registered: true, deviceToken });
});

export const listDeviceTokens = asyncHandler(async (req, res) => {
  const tokens = await DeviceToken.find({ user: req.user.id, isActive: true }).sort('-lastUsedAt').lean();
  ok(res, tokens);
});

export const removeDeviceToken = asyncHandler(async (req, res) => {
  const dt = await DeviceToken.findOneAndDelete({ _id: req.params.id, user: req.user.id });
  if (!dt) throw new ApiError(404, 'Device token not found');
  ok(res, { removed: true });
});

export const deactivateDeviceToken = asyncHandler(async (req, res) => {
  const dt = await DeviceToken.findOneAndUpdate(
    { _id: req.params.id, user: req.user.id },
    { $set: { isActive: false } },
    { new: true }
  );
  if (!dt) throw new ApiError(404, 'Device token not found');
  ok(res, { deactivated: true });
});

// Admin: list all device tokens
export const listAllDeviceTokens = asyncHandler(async (req, res) => {
  const q = req.query;
  const filter = {};
  if (q.platform) filter.platform = q.platform;
  if (q.isActive !== undefined) filter.isActive = q.isActive === 'true';

  const tokens = await DeviceToken.find(filter)
    .populate('user', 'name email role')
    .sort('-lastUsedAt')
    .limit(100)
    .lean();
  ok(res, tokens);
});
