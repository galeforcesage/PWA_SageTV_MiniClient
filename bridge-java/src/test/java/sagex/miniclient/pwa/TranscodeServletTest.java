package sagex.miniclient.pwa;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class TranscodeServletTest {
    @Test
    void growingRecordingAppliesRequestedSeekAfterPipeInput() {
        TranscodeServlet servlet = new TranscodeServlet("ffmpeg", "none");

        List<String> args = servlet.buildArgs(
                "/recordings/Animal Control.mpg",
                105.24,
                HwAccel.software(),
                true);

        int inputIndex = args.indexOf("-i");
        int seekIndex = args.indexOf("-ss");
        assertTrue(inputIndex >= 0);
        assertEquals("pipe:0", args.get(inputIndex + 1));
        assertTrue(seekIndex > inputIndex);
        assertEquals("105.24", args.get(seekIndex + 1));
    }
}
