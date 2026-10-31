import React from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useTheme } from "../theme";

/** Same bounded, accessible numeric field for agent and photo-search limits. */
export function NumericStepper({value, onChange, min=1, max, disabled=false, decreaseLabel,
  increaseLabel, inputLabel}: {
  value:string; onChange:(value:string)=>void; min?:number; max:number;
  disabled?:boolean; decreaseLabel:string; increaseLabel:string; inputLabel:string;
}) {
  const t=useTheme();
  const valid=/^\d+$/.test(value.trim()) && Number(value)>=min && Number(value)<=max;
  const step={minHeight:46,minWidth:46,alignItems:"center" as const,justifyContent:"center" as const,
    borderRadius:14,borderWidth:1,borderColor:t.line};
  return <View style={{flexDirection:"row",alignItems:"center",gap:12}}>
    <Pressable accessibilityRole="button" accessibilityLabel={decreaseLabel}
      accessibilityState={{disabled:disabled||!valid||Number(value)<=min}}
      disabled={disabled||!valid||Number(value)<=min}
      style={step} onPress={()=>onChange(String(Number(value)-1))}>
      <Text style={{color:t.secondary,fontSize:24}}>−</Text>
    </Pressable>
    <TextInput accessibilityLabel={inputLabel} value={value} onChangeText={onChange}
      editable={!disabled} keyboardType="number-pad" inputMode="numeric" selectTextOnFocus
      style={{minHeight:46,width:80,borderWidth:1,borderColor:t.line,borderRadius:14,
        padding:10,color:t.text,textAlign:"center",fontSize:20}}/>
    <Pressable accessibilityRole="button" accessibilityLabel={increaseLabel}
      accessibilityState={{disabled:disabled||!valid||Number(value)>=max}}
      disabled={disabled||!valid||Number(value)>=max}
      style={step} onPress={()=>onChange(String(Number(value)+1))}>
      <Text style={{color:t.secondary,fontSize:24}}>+</Text>
    </Pressable>
  </View>;
}
