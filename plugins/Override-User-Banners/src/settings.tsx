import { ReactNative } from "@vendetta/metro/common";
import { Forms } from "@vendetta/ui/components";
import { storage } from "@vendetta/plugin";
import { useProxy } from "@vendetta/storage";

const { FormDivider, FormInput, FormRow } = Forms;

export default () => {
    useProxy(storage);

    const overrides: { id: string; url: string }[] = storage.overrides ?? [];

    const addOverride = () => {
        storage.overrides = [...overrides, { id: "", url: "" }];
    };

    const removeOverride = (index: number) => {
        storage.overrides = overrides.filter((_, i) => i !== index);
    };

    return (
        <ReactNative.ScrollView>
            {overrides.map((entry, index) => (
                <ReactNative.View key={index}>
                    <FormRow label={`User ${index + 1}`} />
                    <FormInput
                        placeholder="Enter Target User ID"
                        value={entry.id || ""}
                        onChange={(v) => (storage.overrides[index].id = v)}
                    />
                    <FormInput
                        placeholder="Enter banner image URL"
                        value={entry.url || ""}
                        onChange={(v) => (storage.overrides[index].url = v)}
                    />
                    <FormRow
                        label="Remove this user"
                        onPress={() => removeOverride(index)}
                    />
                    <FormDivider />
                </ReactNative.View>
            ))}
            <FormRow
                label="+ Add user"
                onPress={addOverride}
            />
        </ReactNative.ScrollView>
    );
};
