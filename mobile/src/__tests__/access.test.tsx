import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { AccessScreen } from '../screens/AccessScreen';
import { api } from '../api/client';

jest.mock('../api/client', () => ({ api: { requestAccess: jest.fn(), finishAccess: jest.fn() } }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: require('react-native').View }));

beforeEach(() => jest.clearAllMocks());

test('requests a recovery email and completes password reset with the code and 2FA', async () => {
  (api.requestAccess as jest.Mock).mockResolvedValue({ message: 'Проверьте почту' });
  (api.finishAccess as jest.Mock).mockResolvedValue({ message: 'Пароль изменён' });
  const view = render(<AccessScreen onClose={jest.fn()} />);
  fireEvent.changeText(view.getByLabelText('Email для восстановления'), 'user@example.com');
  fireEvent.press(view.getByText('Отправить письмо'));
  await waitFor(() => expect(api.requestAccess).toHaveBeenCalledWith('user@example.com', 'reset'));
  await waitFor(() => expect(view.getByText('Проверьте почту')).toBeTruthy());
  fireEvent.changeText(view.getByLabelText('Код из письма'), 'a'.repeat(32));
  fireEvent.changeText(view.getByLabelText('Новый пароль'), 'new-password');
  fireEvent.changeText(view.getByLabelText('Код 2FA'), 'backup-code');
  fireEvent.press(view.getByText('Подтвердить'));
  await waitFor(() => expect(api.finishAccess).toHaveBeenCalledWith('a'.repeat(32), 'reset', 'new-password', 'backup-code'));
  await waitFor(() => expect(view.getByLabelText('Новый пароль').props.value).toBe(''));
});

test('validates email locally and presents server failures without crashing', async () => {
  (api.requestAccess as jest.Mock).mockRejectedValue(new Error('email_service_unavailable'));
  const view = render(<AccessScreen onClose={jest.fn()} />);
  fireEvent.press(view.getByText('Отправить письмо'));
  expect(api.requestAccess).not.toHaveBeenCalled();
  fireEvent.changeText(view.getByLabelText('Email для восстановления'), 'user@example.com');
  fireEvent.press(view.getByText('Отправить письмо'));
  await waitFor(() => expect(view.getByText(/Почтовый сервис/)).toBeTruthy());
});
