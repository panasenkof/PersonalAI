import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../api/client';
import { useTheme } from '../theme';
import { authError } from '../ux';

export function AccessScreen({onClose}: {onClose:()=>void}) {
  const t=useTheme();
  const [email,setEmail]=useState(''); const [purpose,setPurpose]=useState<'reset'|'verify'>('reset');
  const [code,setCode]=useState(''); const [password,setPassword]=useState(''); const [otp,setOtp]=useState('');
  const [busy,setBusy]=useState(false); const [message,setMessage]=useState('');
  const input=[styles.input,{color:t.text,borderColor:t.line,backgroundColor:t.panel}];
  async function run(finish:boolean) {
    if(busy)return;
    if(finish&&(code.trim().length<20||(purpose==='reset'&&password.length<8))){setMessage('Укажите код из письма и новый пароль от 8 символов.');return;}
    if(!finish&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())){setMessage('Укажите корректный email.');return;}
    setBusy(true);
    try{const result=finish?await api.finishAccess(code.trim(),purpose,password,otp):await api.requestAccess(email.trim(),purpose);setMessage(result.message);if(finish){setCode('');setPassword('');setOtp('');}}
    catch(error){setMessage(authError((error as Error).message));}finally{setBusy(false);}
  }
  return <SafeAreaView style={{flex:1,backgroundColor:t.bg}}><KeyboardAvoidingView style={{flex:1}} behavior={Platform.OS==='ios'?'padding':undefined}><ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.wrap}>
    <Pressable accessibilityRole="button" onPress={onClose} style={styles.button}><Text style={{color:t.accent}}>← Вернуться ко входу</Text></Pressable>
    <Text style={{color:t.text,fontSize:26,fontWeight:'700'}}>Восстановить доступ</Text>
    <Text style={{color:t.muted}}>Для восстановления на сервере должна быть настроена почта. Код из письма можно ввести здесь вручную или открыть ссылку в браузере.</Text>
    <Pressable accessibilityRole="button" style={styles.button} onPress={()=>setPurpose(p=>p==='reset'?'verify':'reset')}><Text style={{color:t.accent}}>{purpose==='reset'?'Режим: сброс пароля. Переключить на подтверждение email':'Режим: подтверждение email. Переключить на сброс пароля'}</Text></Pressable>
    <TextInput accessibilityLabel="Email для восстановления" style={input} autoCapitalize="none" keyboardType="email-address" value={email} onChangeText={setEmail} placeholder="Email" placeholderTextColor={t.muted}/>
    <Pressable disabled={busy} accessibilityRole="button" style={[styles.button,{backgroundColor:t.accent}]} onPress={()=>run(false)}><Text style={{color:'#fff'}}>Отправить письмо</Text></Pressable>
    <TextInput accessibilityLabel="Код из письма" style={input} autoCapitalize="none" autoCorrect={false} value={code} onChangeText={setCode} placeholder="Одноразовый код из письма" placeholderTextColor={t.muted}/>
    {purpose==='reset'?<><TextInput accessibilityLabel="Новый пароль" style={input} secureTextEntry value={password} onChangeText={setPassword} placeholder="Новый пароль (от 8 символов)" placeholderTextColor={t.muted}/><TextInput accessibilityLabel="Код 2FA" style={input} autoCapitalize="none" value={otp} onChangeText={setOtp} placeholder="Код 2FA или резервный код, если включена 2FA" placeholderTextColor={t.muted}/></>:null}
    <Pressable disabled={busy} accessibilityRole="button" style={[styles.button,{backgroundColor:t.accent}]} onPress={()=>run(true)}><Text style={{color:'#fff'}}>Подтвердить</Text></Pressable>
    <Text accessibilityRole="alert" style={{color:t.text}}>{message}</Text>
  </ScrollView></KeyboardAvoidingView></SafeAreaView>;
}
const styles=StyleSheet.create({wrap:{padding:24,gap:12},input:{borderWidth:1,borderRadius:12,padding:14,fontSize:16},button:{minHeight:44,padding:12,borderRadius:12,justifyContent:'center'}});
