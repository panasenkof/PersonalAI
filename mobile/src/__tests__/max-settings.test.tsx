import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { SettingsScreen } from '../screens/SettingsScreen';
import { api } from '../api/client';

jest.mock('../api/client', () => ({api: {
  serviceInfo: jest.fn(async () => ({})),
  llmSettings: jest.fn(async () => null),
  privacyCollections: jest.fn(async () => []),
  privacyHistory: jest.fn(async () => ({ allow_cloud_history: false })),
  privacyIntegrations: jest.fn(async () => ({ allow_remote_stt: false, allow_mcp_access: false })),
  linkCode: jest.fn(),
}}));
jest.mock('../auth/AuthContext', () => ({useAuth: () => ({me:{email:'test@example.com',channels:{max:true}},apiBase:'https://pia.example.com'})}));
jest.mock('../share', () => ({sharePrivateFile: jest.fn()}));

test('MAX shows linked state and generates a code when tapped', async () => {
  (api.linkCode as jest.Mock).mockResolvedValue({code:'AABBCCDD',instructions:'Отправьте /start AABBCCDD боту MAX'});
  const view = render(<SettingsScreen />);
  expect(view.getByText(/MAX.*привязан/)).toBeTruthy();
  fireEvent.press(view.getByLabelText('Получить код привязки MAX'));
  await waitFor(() => expect(api.linkCode).toHaveBeenCalledWith('max'));
  await waitFor(() => expect(view.getByText(/AABBCCDD/)).toBeTruthy());
});
