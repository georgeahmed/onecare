import { PortalSubmission } from './types';

export const submitIntake = async (payload: PortalSubmission): Promise<void> => {
  void payload;
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
};
